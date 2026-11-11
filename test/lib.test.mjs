import test from 'node:test';
import assert from 'node:assert/strict';
import { availableMemory } from '../hooks/lib.mjs';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4324.
Pages active:                                 192588.
Pages inactive:                               191603.
Pages speculative:                               293.
Pages throttled:                                   0.
Pages wired down:                             154985.
Pages purgeable:                                   4.
`;

test('macOS 可用内存包含可回收的 inactive 页', () => {
    const bytes = availableMemory('darwin', () => VM_STAT);
    assert.equal(bytes, (4324 + 191603 + 293 + 4) * 16384);
    assert.ok(bytes / 1024 ** 3 > 2.9, '约 3 GB，而不是只算 free 的 0.07 GB');
});

test('vm_stat 不可用时不输出可用内存，而不是给出错误数值', () => {
    assert.equal(availableMemory('darwin', () => {
        throw new Error('no vm_stat');
    }), null);
});
