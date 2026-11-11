import test from 'node:test';
import assert from 'node:assert/strict';
import { findDanger, reviewChanges } from '../hooks/checks.mjs';

test('findDanger 识别危险命令', () => {
    for (const cmd of [
        'rm -rf src',
        'cd x && rm -fr ~/project',
        'sudo rm -rf /',
        'git reset --hard HEAD~1',
        'git push origin main --force',
        'git push -f',
        'git clean -fdx',
        'git checkout .',
        'mysql -e "DROP TABLE users"',
        'psql -c "delete from orders;"',
        'kubectl -n prod delete pod x',
    ]) {
        assert.ok(findDanger(cmd), cmd);
    }
});

test('findDanger 放行常见安全命令', () => {
    for (const cmd of [
        'rm -rf node_modules dist',
        'rm -rf ./build /tmp/foo',
        'rm file.txt',
        'git push origin feature',
        'git reset HEAD~1',
        'git checkout -b feat',
        'psql -c "delete from orders where id = 1"',
        'ls -la',
        undefined,
    ]) {
        assert.equal(findDanger(cmd), null, String(cmd));
    }
});

const change = (path, code, lines) => ({ path, code, added: lines.map((text, i) => ({ line: i + 1, text })) });

test('reviewChanges 发现新增文档', () => {
    const f = reviewChanges([change('docs/plan-2026.md', '??', ['# plan'])]);
    assert.match(f.join(), /新增了 1 个文档/);
});

test('reviewChanges 放行 README、.scratch 与项目白名单', () => {
    const f = reviewChanges([
        change('README.md', '??', ['x']),
        change('.scratch/notes.md', '??', ['x']),
        change('openspec/changes/a/proposal.md', '??', ['x']),
    ], ['openspec/']);
    assert.deepEqual(f, []);
});

test('reviewChanges 发现写进文档的环境事实', () => {
    for (const text of [
        '本机资源不够，不能运行 768MB 以上的进程',
        '我们的 vps 只有 2C4G，不要跑模拟器',
        '当前在 macmini 上，内存充足可以跑大的验证',
    ]) {
        const f = reviewChanges([change('AGENTS.md', ' M', [text])]);
        assert.match(f.join(), /环境事实/, text);
    }
});

test('reviewChanges 不把代码里的内存配置当成环境事实', () => {
    const f = reviewChanges([change('src/Main.java', ' M', ['int memoryMb = 768; // 本机缓存上限'])]);
    assert.deepEqual(f, []);
});

test('reviewChanges 发现删测试与加 skip', () => {
    const f = reviewChanges([
        change('src/test/java/FooTest.java', ' D', []),
        change('src/test/java/BarTest.java', ' M', ['    @Disabled']),
    ]);
    assert.match(f.join(), /删除了测试文件/);
    assert.match(f.join(), /跳过测试/);
});

test('reviewChanges 发现文档远多于代码', () => {
    const doc = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const f = reviewChanges([change('README.md', ' M', doc), change('a.js', ' M', ['x'])]);
    assert.match(f.join(), /文档明显多于代码/);
});
