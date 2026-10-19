import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dataDirectory, savedDataDirectory, directoryParents} from '../src/data-directory';
import {DATA_FOLDER} from '../src/model';

test('annotation directories support nested vault-relative paths, normalize trailing separators and retain the default', () => {
  assert.equal(savedDataDirectory(undefined), DATA_FOLDER);
  assert.equal(dataDirectory(' Highnote/annotations/ '), 'Highnote/annotations');
  assert.equal(dataDirectory('阅读资料/Highnote 数据/评论'), '阅读资料/Highnote 数据/评论');
  assert.deepEqual(directoryParents('Highnote/annotations/评论'), ['Highnote', 'Highnote/annotations', 'Highnote/annotations/评论']);
  assert.equal(dataDirectory(DATA_FOLDER), DATA_FOLDER);
});

test('absolute paths, traversal and nonportable directory names never resolve outside the vault', () => {
  for (const path of ['', '/', '/tmp/notes', '../notes', 'a/../notes', 'a/./notes', 'a//notes',
    'C:\\notes', 'file://notes', 'a\\notes', 'a /notes', 'a/ notes', 'a./notes', 'con/data', 'NUL', 'notes\u0000',
    'notes\n/data', 'notes\u007f/data', 'notes?', 'a'.repeat(501)]) assert.throws(() => dataDirectory(path));
  assert.throws(() => savedDataDirectory('a/../../notes'));
});
