/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {TextSnapshotNode} from '../types.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

type LocatorCandidate = {
  strategy: string;
  attribute?: string;
  value?: string;
  selector?: string;
  xpath?: string;
  unique?: boolean;
  source: 'dom' | 'ax';
};

type DomLocatorDescription = {
  tagName: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  dataTestId?: string;
  role?: string;
  text?: string;
  cssPath?: string;
  xpath?: string;
  parentChain: Array<{
    tagName: string;
    id?: string;
    name?: string;
    role?: string;
    dataTestId?: string;
  }>;
  locators: LocatorCandidate[];
};

const includeSnapshotSchema = zod
  .boolean()
  .optional()
  .describe('Whether to include a fresh snapshot in the response. Default is false.');

function normalizeNodeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function buildRoleLocatorCandidate(
  node: TextSnapshotNode | undefined,
): LocatorCandidate | null {
  if (!node) {
    return null;
  }

  const role = normalizeNodeString(node.role);
  const name = normalizeNodeString(node.name);

  if (role && name) {
    return {
      strategy: 'role',
      value: `${role}:${name}`,
      source: 'ax',
    };
  }

  if (role) {
    return {
      strategy: 'role',
      value: role,
      source: 'ax',
    };
  }

  return null;
}

export const describeUid = definePageTool({
  name: 'describe_uid',
  description:
    'Describe a snapshot uid and return locator candidates that can be used to build a stable replay recipe.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uid: zod
      .string()
      .describe('The uid of an element on the page from the page content snapshot'),
    includeSnapshot: includeSnapshotSchema,
  },
  handler: async (request, response) => {
    const uid = request.params.uid;
    const axNode = request.page.getAXNodeByUid(uid);
    const handle = await request.page.getElementByUid(uid);

    try {
      const dom = await handle.evaluate((el: Element): DomLocatorDescription => {
        const maxTextLength = 160;
        const seenLocators = new Set<string>();
        const tagName = el.tagName.toLowerCase();
        const textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();

        const normalize = (
          value: string | null | undefined,
        ): string | undefined => {
          if (typeof value !== 'string') {
            return undefined;
          }
          const normalized = value.trim();
          return normalized ? normalized : undefined;
        };

        const escapeCssIdentifier = (value: string): string => {
          if (globalThis.CSS?.escape) {
            return globalThis.CSS.escape(value);
          }
          return value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
        };

        const escapeCssString = (value: string): string => {
          return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        };

        const toXPathLiteral = (value: string): string => {
          if (!value.includes('"')) {
            return `"${value}"`;
          }
          if (!value.includes("'")) {
            return `'${value}'`;
          }
          const parts = value.split('"');
          return `concat(${parts
            .map((part, index) => {
              const literal = part ? `"${part}"` : '""';
              return index === parts.length - 1 ? literal : `${literal}, '"', `;
            })
            .join('')})`;
        };

        const cssUnique = (selector: string): boolean => {
          try {
            const matches = document.querySelectorAll(selector);
            return matches.length === 1 && matches[0] === el;
          } catch {
            return false;
          }
        };

        const xpathUnique = (xpath: string): boolean => {
          try {
            const result = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            return result.snapshotLength === 1 && result.snapshotItem(0) === el;
          } catch {
            return false;
          }
        };

        const locators: LocatorCandidate[] = [];
        const addLocator = (candidate: LocatorCandidate) => {
          const dedupeKey = JSON.stringify(candidate);
          if (seenLocators.has(dedupeKey)) {
            return;
          }
          seenLocators.add(dedupeKey);
          locators.push(candidate);
        };

        const addAttributeLocator = (
          strategy: string,
          attribute: string,
          value: string | undefined,
          selectorFactory: (value: string) => string,
          xpathFactory: (value: string) => string,
        ) => {
          if (!value) {
            return;
          }
          const selector = selectorFactory(value);
          const xpath = xpathFactory(value);
          const selectorIsUnique = cssUnique(selector);
          const xpathIsUnique = xpathUnique(xpath);
          addLocator({
            strategy,
            attribute,
            value,
            selector,
            xpath,
            unique: selectorIsUnique || xpathIsUnique,
            source: 'dom',
          });
        };

        const buildCssPath = (node: Element): string => {
          const segments: string[] = [];
          let current: Element | null = node;
          while (
            current &&
            current.nodeType === Node.ELEMENT_NODE &&
            segments.length < 6
          ) {
            let segment = current.tagName.toLowerCase();
            const currentId = normalize(current.getAttribute('id'));
            const currentTestId = normalize(current.getAttribute('data-testid'));
            if (currentId) {
              segment += `#${escapeCssIdentifier(currentId)}`;
              segments.unshift(segment);
              break;
            }
            if (currentTestId) {
              segment += `[data-testid="${escapeCssString(currentTestId)}"]`;
              segments.unshift(segment);
              break;
            }
            const siblings = current.parentElement
              ? Array.from(current.parentElement.children).filter(
                  sibling => sibling.tagName === current?.tagName,
                )
              : [];
            if (siblings.length > 1) {
              segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            segments.unshift(segment);
            current = current.parentElement;
          }
          return segments.join(' > ');
        };

        const buildXPath = (node: Element): string => {
          const segments: string[] = [];
          let current: Element | null = node;
          while (
            current &&
            current.nodeType === Node.ELEMENT_NODE &&
            segments.length < 6
          ) {
            const currentId = normalize(current.getAttribute('id'));
            if (currentId) {
              segments.unshift(`*[@id=${toXPathLiteral(currentId)}]`);
              return `//${segments.join('/')}`;
            }
            const siblings = current.parentElement
              ? Array.from(current.parentElement.children).filter(
                  sibling => sibling.tagName === current?.tagName,
                )
              : [];
            const index = siblings.length > 1 ? siblings.indexOf(current) + 1 : 1;
            segments.unshift(`${current.tagName.toLowerCase()}[${index}]`);
            current = current.parentElement;
          }
          return `//${segments.join('/')}`;
        };

        const id = normalize(el.getAttribute('id'));
        const name = normalize(el.getAttribute('name'));
        const placeholder = normalize(el.getAttribute('placeholder'));
        const ariaLabel = normalize(el.getAttribute('aria-label'));
        const dataTestId = normalize(el.getAttribute('data-testid'));
        const role = normalize(el.getAttribute('role'));
        const type = normalize(el.getAttribute('type'));
        const text = textContent ? textContent.slice(0, maxTextLength) : undefined;

        addAttributeLocator(
          'id',
          'id',
          id,
          value => `#${escapeCssIdentifier(value)}`,
          value => `//*[@id=${toXPathLiteral(value)}]`,
        );
        addAttributeLocator(
          'data-testid',
          'data-testid',
          dataTestId,
          value => `[data-testid="${escapeCssString(value)}"]`,
          value => `//*[@data-testid=${toXPathLiteral(value)}]`,
        );
        addAttributeLocator(
          'name',
          'name',
          name,
          value => `${tagName}[name="${escapeCssString(value)}"]`,
          value => `//${tagName}[@name=${toXPathLiteral(value)}]`,
        );
        addAttributeLocator(
          'placeholder',
          'placeholder',
          placeholder,
          value => `${tagName}[placeholder="${escapeCssString(value)}"]`,
          value => `//${tagName}[@placeholder=${toXPathLiteral(value)}]`,
        );
        addAttributeLocator(
          'aria-label',
          'aria-label',
          ariaLabel,
          value => `${tagName}[aria-label="${escapeCssString(value)}"]`,
          value => `//${tagName}[@aria-label=${toXPathLiteral(value)}]`,
        );

        if (text) {
          const xpath = `//${tagName}[normalize-space()=${toXPathLiteral(text)}]`;
          addLocator({
            strategy: 'text',
            value: text,
            xpath,
            unique: xpathUnique(xpath),
            source: 'dom',
          });
        }

        const cssPath = buildCssPath(el);
        const xpath = buildXPath(el);
        addLocator({
          strategy: 'css-path',
          selector: cssPath,
          unique: cssUnique(cssPath),
          source: 'dom',
        });
        addLocator({
          strategy: 'xpath',
          xpath,
          unique: xpathUnique(xpath),
          source: 'dom',
        });

        const parentChain: DomLocatorDescription['parentChain'] = [];
        let parent: Element | null = el.parentElement;
        while (parent && parentChain.length < 5) {
          parentChain.push({
            tagName: parent.tagName.toLowerCase(),
            id: normalize(parent.getAttribute('id')),
            name: normalize(parent.getAttribute('name')),
            role: normalize(parent.getAttribute('role')),
            dataTestId: normalize(parent.getAttribute('data-testid')),
          });
          parent = parent.parentElement;
        }

        return {
          tagName,
          id,
          name,
          type,
          placeholder,
          ariaLabel,
          dataTestId,
          role,
          text,
          cssPath,
          xpath,
          parentChain,
          locators,
        };
      });

      const roleLocator = buildRoleLocatorCandidate(axNode || undefined);
      const locators = roleLocator ? [roleLocator, ...dom.locators] : dom.locators;
      const recommendedLocators = locators.filter(
        (locator: LocatorCandidate) => locator.unique !== false,
      );

      response.appendResponseLine(
        JSON.stringify(
          {
            uid,
            ax: axNode
              ? {
                  role: normalizeNodeString(axNode.role),
                  name: normalizeNodeString(axNode.name),
                  value:
                    typeof axNode.value === 'string' || typeof axNode.value === 'number'
                      ? String(axNode.value)
                      : undefined,
                  description: normalizeNodeString(axNode.description),
                }
              : null,
            dom,
            locators,
            recommendedLocators,
          },
          null,
          2,
        ),
      );

      if (request.params.includeSnapshot) {
        response.includeSnapshot();
      }
    } finally {
      void handle.dispose();
    }
  },
});
