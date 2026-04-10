/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {describeUid} from '../../src/tools/locator.js';
import {html, withMcpContext} from '../utils.js';

describe('locator', () => {
  it('describes a uid and returns stable locator candidates', async () => {
    await withMcpContext(async (response, context) => {
      const page = context.getSelectedMcpPage();
      await page.pptrPage.setContent(
        html`<label for="kw">搜索</label>
          <input
            id="kw"
            name="q"
            placeholder="请输入关键词"
            aria-label="搜索框"
            data-testid="search-box"
          />`,
      );
      await context.createTextSnapshot(page, true, undefined);

      const uid = [...(page.textSnapshot?.idToNode.values() ?? [])].find(
        node => node.role === 'textbox',
      )?.id;

      assert.ok(uid, 'expected textbox uid from snapshot');

      await describeUid.handler(
        {
          params: {
            uid: uid as string,
          },
          page,
        },
        response,
        context,
      );

      const result = JSON.parse(response.responseLines[0]) as {
        ax: {role?: string; name?: string} | null;
        dom: {id?: string; name?: string; placeholder?: string};
        recommendedLocators: Array<{
          strategy: string;
          attribute?: string;
          value?: string;
          unique?: boolean;
        }>;
      };

      assert.strictEqual(result.ax?.role, 'textbox');
      assert.strictEqual(result.dom.id, 'kw');
      assert.strictEqual(result.dom.name, 'q');
      assert.strictEqual(result.dom.placeholder, '请输入关键词');
      assert.ok(
        result.recommendedLocators.some(
          locator =>
            locator.strategy === 'id' &&
            locator.attribute === 'id' &&
            locator.value === 'kw' &&
            locator.unique === true,
        ),
      );
      assert.ok(
        result.recommendedLocators.some(
          locator =>
            locator.strategy === 'data-testid' &&
            locator.attribute === 'data-testid' &&
            locator.value === 'search-box' &&
            locator.unique === true,
        ),
      );
    });
  });
});
