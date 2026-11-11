import test from 'node:test';
import assert from 'node:assert/strict';
import { findDanger, splitStatements, tokenize } from '../hooks/danger.mjs';

test('分词：引号与转义', () => {
    assert.deepEqual(tokenize(`rm "-rf" 'a b' c\\ d`), ['rm', '-rf', 'a b', 'c d']);
    assert.deepEqual(splitStatements('a; b && c | d\ne || "x;y"'), ['a', 'b', 'c', 'd', 'e', '"x;y"']);
});

test('识别危险命令（含评审中的绕过写法）', () => {
    for (const cmd of [
        'rm -rf src',
        'cd x && rm -fr ~/project',
        'sudo rm -rf /',
        'rm -r -f lib',
        'rm --recursive --force lib',
        'rm "-rf" src',
        'rm -rf node_modules/../src',
        'rm -rf /tmp/../etc',
        'bash -c "rm -rf src"',
        "sh -c 'rm -rf src'",
        'bash -lc "rm -rf ~"',
        'echo $(rm -rf ~)',
        'echo `rm -rf ~`',
        'eval "rm -rf src"',
        'set -e\nrm -rf src\necho done',
        'FOO=1 rm -rf src',
        'git reset --hard HEAD~1',
        'git -C repo reset --hard',
        'git push origin main --force',
        'git push -f',
        'git push -uf origin main',
        'git push origin +main',
        'git push origin :feature',
        'git push --mirror',
        'git push origin --delete feature',
        'git clean -fdx',
        'git checkout .',
        'git restore .',
        'git branch -D feat',
        'git stash clear',
        'mysql -e "DROP TABLE users"',
        'psql -c "delete from orders;"',
        'kubectl -n prod delete pod x',
        'terraform destroy',
        'dd if=/dev/zero of=/dev/disk2',
    ]) {
        assert.ok(findDanger(cmd), JSON.stringify(cmd));
    }
});

test('argv 数组形式的命令（Codex）', () => {
    assert.ok(findDanger(['bash', '-lc', 'rm -rf src']));
    assert.ok(findDanger(['rm', '-rf', 'src']));
    assert.equal(findDanger(['bash', '-lc', 'ls -la']), null);
    assert.equal(findDanger(['rm', '-rf', 'node_modules']), null);
});

test('放行常见安全命令（含评审中的误报）', () => {
    for (const cmd of [
        'rm -rf node_modules dist',
        'rm -rf ./build /tmp/foo',
        'rm file.txt',
        'rm --force file.txt',
        'git push origin feature',
        'git push -u origin feature',
        'git reset HEAD~1',
        'git checkout -b feat',
        'git restore --staged .',
        'git clean -n -f',
        'git branch -d merged',
        'grep "git reset --hard" notes.log',
        'echo "rm -rf /"',
        'psql -c "delete from orders where id = 1"',
        'psql -c "DELETE FROM orders\n  WHERE id = 1"',
        'ls -la',
        undefined,
    ]) {
        assert.equal(findDanger(cmd), null, JSON.stringify(cmd));
    }
});
