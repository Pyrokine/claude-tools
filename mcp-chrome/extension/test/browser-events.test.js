import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionHandler } from '../src/background/actions.ts';
import { BrowserEventHandler } from '../src/background/browser-event-handler.ts';
import { markManagedTab, restoreManagedTabs, unmarkManagedTab } from '../src/background/tab-state.ts';
