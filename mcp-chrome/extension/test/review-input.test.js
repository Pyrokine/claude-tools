import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installDomHelpers } from '../../src/core/dom-helpers.ts';
import {
    dispatchInputToElement,
    installActionabilityHelpers,
    performActionableClick,
    simulateKeyboardType,
    simulateKeyEvent,
    simulateMouseClick,
    simulateMouseEvent,
} from '../src/background/page-scripts.ts';

function shadowFixture() {
    const dispatched = [];
    const delegated = [];
    class Element {
        constructor(tagName = 'DIV') {
            Object.assign(this, {
                tagName,
                localName: tagName.toLowerCase(),
                namespaceURI: 'http://www.w3.org/1999/xhtml',
                id: tagName.toLowerCase(),
                isConnected: true,
                parentNode: null,
            });
        }

        getBoundingClientRect() {
            return { x: 20, y: 30, top: 30, left: 20, right: 100, bottom: 60, width: 80, height: 30 };
        }

        getAttribute() {
            return null;
        }

        querySelector() {
            return null;
        }

        checkVisibility() {
            return true;
        }

        matches(selector) {
            return selector === ':disabled' && Boolean(this.disabled);
        }

        focus() {}
        scrollIntoView() {}
        dispatchEvent(event) {
            dispatched.push(event);
            let current = this.parentNode;
            while (event.bubbles && current) {
                if (current.host && !event.composed) {
                    break;
                }
                current = current.host ?? current;
                if (current === host || current === document) {
                    delegated.push({ current, event });
                }
                current = current.parentNode;
            }
            return true;
        }
    }
    class Input extends Element {
        constructor() {
            super('INPUT');
            this._value = '';
        }

        get value() {
            return this._value;
        }

        set value(value) {
            this._value = value;
        }
    }
    class SyntheticEvent {
        constructor(type, options = {}) {
            Object.assign(this, { type, composed: false, bubbles: false }, options);
        }
    }
    const host = new Element();
    const input = new Input();
    const body = new Element('BODY');
    const shadow = { host, activeElement: input, elementFromPoint: () => input };
    const document = { activeElement: host, body, elementFromPoint: () => host, elementsFromPoint: () => [host] };
    host.parentNode = body;
    host.shadowRoot = shadow;
    body.parentNode = document;
    input.parentNode = shadow;
    const realm = vm.createContext({
        document,
        Element,
        HTMLElement: Element,
        HTMLInputElement: Input,
        HTMLTextAreaElement: Input,
        Event: SyntheticEvent,
        MouseEvent: SyntheticEvent,
        KeyboardEvent: SyntheticEvent,
        InputEvent: SyntheticEvent,
        CSS: { escape: (value) => value },
        innerWidth: 800,
        innerHeight: 600,
        screenX: 0,
        screenY: 0,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
        __mcpElementMap: { host: new WeakRef(host), input: new WeakRef(input) },
    });
    realm.window = realm;
    for (const fn of [installDomHelpers, installActionabilityHelpers]) {
        vm.runInContext(`(${fn.toString()})()`, realm);
    }
    return {
        host,
        input,
        document,
        dispatched,
        delegated,
        realm,
        call: (fn, ...args) => vm.runInContext(`(${fn.toString()})`, realm)(...args),
    };
}

test('C30-06 actionable Shadow host accepts nested descendants and rejects an unrelated overlay', () => {
    const fixture = shadowFixture();
    assert.equal(fixture.realm.__mcpActionability.check('host').actionable, true);
    const innerHost = { parentNode: fixture.host.shadowRoot };
    const nestedShadow = { host: innerHost, elementFromPoint: () => fixture.input };
    innerHost.shadowRoot = nestedShadow;
    fixture.input.parentNode = nestedShadow;
    fixture.host.shadowRoot.elementFromPoint = () => innerHost;
    assert.equal(fixture.realm.__mcpActionability.check('host').actionable, true);
    fixture.document.elementFromPoint = () => ({
        tagName: 'DIV',
        id: 'overlay',
        className: '',
        parentNode: fixture.document.body,
        getBoundingClientRect: fixture.host.getBoundingClientRect,
    });
    const covered = fixture.realm.__mcpActionability.check('host');
    assert.equal(covered.actionable, false);
    assert.equal(covered.reason, 'covered');
});

test('C30-07 synthetic click paths cross Shadow boundaries while mouseenter stays local', () => {
    for (const dispatch of [
        (fixture) => fixture.call(simulateMouseClick, 40, 40, 'left'),
        (fixture) => fixture.call(simulateMouseEvent, 'mouseup', 40, 40, 'left'),
        (fixture) => fixture.call(performActionableClick, 'input', false),
        (fixture) => fixture.call(performActionableClick, 'input', true),
    ]) {
        const fixture = shadowFixture();
        assert.equal(dispatch(fixture).success, true);
        for (const target of [fixture.host, fixture.document]) {
            assert.ok(fixture.delegated.some(({ current, event }) => current === target && event.type === 'click'));
        }
        for (const event of fixture.dispatched.filter(
            ({ type }) => type === 'click' || type === 'mousedown' || type === 'mouseup'
        )) {
            assert.equal(event.composed, true, event.type);
        }
        for (const event of fixture.dispatched.filter(({ type }) => type === 'mouseenter')) {
            assert.equal(event.composed, false);
            assert.equal(event.bubbles, false);
            assert.ok(fixture.delegated.every((entry) => entry.event !== event));
        }
    }
});

test('C30-07 keyboard and controlled input reach delegated listeners and change remains local', async () => {
    for (const dispatch of [
        (fixture) => fixture.call(simulateKeyboardType, 'a', 0),
        (fixture) => fixture.call(simulateKeyEvent, 'a', 'press', []),
        (fixture) => fixture.call(dispatchInputToElement, 'input', 'controlled'),
    ]) {
        const fixture = shadowFixture();
        assert.equal((await dispatch(fixture)).success, true);
        const events = fixture.dispatched.filter(({ type }) =>
            ['keydown', 'keypress', 'keyup', 'input'].includes(type)
        );
        assert.ok(events.length > 0);
        for (const event of events) {
            assert.equal(event.composed, true, event.type);
            for (const target of [fixture.host, fixture.document]) {
                assert.ok(fixture.delegated.some((entry) => entry.current === target && entry.event === event));
            }
        }
        for (const event of fixture.dispatched.filter(({ type }) => type === 'change')) {
            assert.equal(event.composed, false);
            assert.ok(fixture.delegated.every((entry) => entry.event !== event));
        }
    }
});
