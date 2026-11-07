import assert from 'node:assert/strict';
import test from 'node:test';
import { osLeftClick } from '../dist/core/os-mouse.js';

test('native pointer recalibration samples real motion before its single press', async () => {
    const commands = [];
    let reads = 0;
    let pointer = { x: 280, y: 326 };
    await osLeftClick(280, 326, {
        platform: 'linux',
        deadline: Date.now() + 2000,
        path: [{ x: 280, y: 326 }],
        sleep: async () => {},
        execFile: async (_file, args) => {
            commands.push([...args]);
            if (args[0] === 'mousemove') {
                pointer = { x: Number(args[1]), y: Number(args[2]) };
            }
            if (args[0] === 'mousemove_relative') {
                pointer.x += Number(args[2]);
            }
            return { stdout: `X=${pointer.x}\nY=${pointer.y}\n`, stderr: '' };
        },
        refreshPoint: async (probe) => {
            const fresh = await probe();
            assert.deepEqual(fresh.position, pointer);
            assert.ok(fresh.since <= Date.now());
            ++reads;
            return { x: 280, y: 270 };
        },
    });
    assert.equal(reads, 2);
    assert.equal(commands.filter((args) => args[0] === 'mousedown').length, 1);
    assert.equal(commands.filter((args) => args[0] === 'mouseup').length, 1);
    assert.deepEqual(commands.filter((args) => args[0] === 'mousemove_relative').slice(-2), [
        ['mousemove_relative', '--', '-1', '0'],
        ['mousemove_relative', '--', '1', '0'],
    ]);
});

test('missing trustworthy native pointer sample dispatches no press', async () => {
    const commands = [];
    await assert.rejects(
        osLeftClick(10, 20, {
            platform: 'linux',
            deadline: Date.now() + 2000,
            path: [{ x: 10, y: 20 }],
            sleep: async () => {},
            execFile: async (_file, args) => {
                commands.push([...args]);
                return { stdout: 'X=10\nY=20\n', stderr: '' };
            },
            refreshPoint: async (probe) => {
                await probe();
                throw new Error('trusted sample unavailable');
            },
        }),
        /trusted sample unavailable/
    );
    assert.equal(commands.filter((args) => args[0] === 'mousedown').length, 0);
});
