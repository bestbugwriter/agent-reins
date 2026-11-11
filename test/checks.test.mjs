import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewChanges, resolveConfig } from '../hooks/checks.mjs';

const lines = (arr) => arr.map((text, i) => ({ line: i + 1, text }));
const change = (path, code, added = [], removed = [], from) => ({ path, code, from, added: lines(added), removed: lines(removed) });
const review = (changes, extra = {}) => reviewChanges({ changes, config: resolveConfig(undefined).config, ...extra });

test('发现新增文档', () => {
    assert.match(review([change('docs/plan-2026.md', '??', ['# plan'])]).join(), /新增了 1 个文档/);
});

test('放行 README、.scratch 与项目白名单', () => {
    const config = resolveConfig({ allowDocs: ['docs/adr/'] }).config;
    const f = review([
        change('README.md', '??', ['x']),
        change('.scratch/notes.md', '??', ['x']),
        change('docs/adr/0001.md', '??', ['x']),
    ], { config });
    assert.deepEqual(f, []);
});

test('有 openspec 目录时自动放行，但受数量和行数上限约束', () => {
    const { config } = resolveConfig(undefined, { hasOpenspec: true });
    assert.ok(config.allowDocs.includes('openspec/'));
    assert.deepEqual(review([change('openspec/changes/a/proposal.md', '??', ['x'])], { config }), []);

    const many = Array.from({ length: 6 }, (_, i) => change(`openspec/changes/a/f${i}.md`, '??', ['x']));
    assert.match(review(many, { config }).join(), /流程文档新增了 6 个，超过上限 5 个/);

    const long = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    assert.match(review([change('openspec/changes/a/design.md', '??', long), change('a.js', ' M', ['x'])], { config }).join(), /超过上限 200 行/);
});

test('改名为文档也算新增文档', () => {
    assert.match(review([change('docs/notes.md', 'R ', ['x'], [], 'scripts/notes.txt')]).join(), /新增了 1 个文档/);
});

test('发现写进文档的环境事实', () => {
    for (const text of [
        '本机资源不够，不能运行 768MB 以上的进程',
        '我们的 vps 只有 2C4G，不要跑模拟器',
        '当前在 macmini 上，内存充足可以跑大的验证',
    ]) {
        assert.match(review([change('AGENTS.md', ' M', [text])]).join(), /环境事实/, text);
    }
});

test('不把代码里的内存配置当成环境事实', () => {
    assert.deepEqual(review([change('src/Main.java', ' M', ['int memoryMb = 768; // 本机缓存上限'])]), []);
});

test('发现删测试、改名移出测试目录、加 skip', () => {
    const f = review([
        change('src/test/java/FooTest.java', ' D'),
        change('src/main/java/Bar.java', 'R ', [], [], 'src/test/java/BarTest.java'),
        change('src/test/java/BazTest.java', ' M', ['    @Disabled']),
    ]).join();
    assert.match(f, /FooTest\.java/);
    assert.match(f, /BarTest\.java/);
    assert.match(f, /跳过测试/);
});

test('文档远多于代码', () => {
    const doc = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    assert.match(review([change('README.md', ' M', doc), change('a.js', ' M', ['x'])]).join(), /文档明显多于代码/);
});

test('.comet 过程文件和锁文件不计入行数', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`);
    assert.deepEqual(review([change('openspec/changes/a/.comet/checks/x.log', '??', big), change('package-lock.json', ' M', big)]), []);
});

test('改了逻辑但没改测试时提醒（仓库已有测试）', () => {
    const code = ['if (a) {', '  return b;', '}', 'x = 1;', 'y = 2;'];
    const changes = [change('src/main/java/Svc.java', ' M', code)];
    assert.match(review(changes, { repoHasTests: true }).join(), /没有改动任何测试/);
    assert.deepEqual(review(changes, { repoHasTests: false }), []);
    assert.deepEqual(review([...changes, change('src/test/java/SvcTest.java', ' M', ['assert x'])], { repoHasTests: true }), []);
});

test('删除或改名的标识符仍被其他文件引用', () => {
    const changes = [change('src/Svc.java', ' M', ['void computeTotalAmount() {}'], ['void computeTotal() {}'])];
    let asked;
    const f = review(changes, {
        readFile: () => 'void computeTotalAmount() {}',
        refsTo: (ids, exclude) => {
            asked = { ids, exclude };
            return [{ id: 'computeTotal', file: 'docs/billing.md', line: 12 }];
        },
    });
    assert.ok(asked.ids.includes('computeTotal'));
    assert.ok(!asked.ids.includes('computeTotalAmount'), '新名字不应被当成已删除');
    assert.deepEqual(asked.exclude, ['src/Svc.java']);
    assert.match(f.join(), /`computeTotal` → docs\/billing\.md:12/);
});

test('标识符仍在当前文件中或在 import 行时不算删除', () => {
    let asked = null;
    review([change('src/Svc.java', ' M', [], ['import com.foo.OldHelper;', '  helperCount_total++;'])], {
        readFile: () => 'int helperCount_total;',
        refsTo: (ids) => {
            asked = ids;
            return [];
        },
    });
    assert.equal(asked, null);
});

test('删除的配置项仍出现在文档中', () => {
    const f = review([change('conf/app.properties', ' M', [], ['job.retry.max.count=3'])], {
        readFile: () => '',
        refsTo: (ids) => ids.map((id) => ({ id, file: 'docs/config.md', line: 3 })),
    });
    assert.match(f.join(), /job\.retry\.max\.count/);
});

test('文档锚点指向已不存在的符号、文档引用已删除的文件', () => {
    const f = review([
        change('src/Svc.java', ' M', ['void newName() {}'], ['void oldName() {}']),
        change('src/Legacy.java', ' D', [], ['class Legacy {}']),
    ], {
        readFile: (p) => (p === 'src/Svc.java' ? 'void newName() {}' : null),
        refsTo: () => [],
        docRefsTo: () => [
            { file: 'docs/a.md', line: 4, text: '见 `Svc.java#oldName`' },
            { file: 'docs/a.md', line: 5, text: '见 `Svc.java#newName`' },
            { file: 'docs/b.md', line: 9, text: '入口在 Legacy.java' },
        ],
    }).join();
    assert.match(f, /docs\/a\.md:4 的锚点 Svc\.java#oldName 已不存在/);
    assert.doesNotMatch(f, /newName 已不存在/);
    assert.match(f, /docs\/b\.md:9 引用了已删除或改名的 src\/Legacy\.java/);
});

test('配置校验：类型错误时报告并回退默认值', () => {
    const r = resolveConfig({ allowDocs: 'openspec/' });
    assert.match(r.error, /allowDocs/);
    assert.deepEqual(r.config.allowDocs, []);
    assert.match(resolveConfig([1]).error, /JSON 对象/);
    assert.equal(resolveConfig({ docBudget: { files: 2 } }).config.docBudget.files, 2);
});
