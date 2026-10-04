import test from 'node:test';
import assert from 'node:assert/strict';
import {extractResumeText} from '../../src/resume/extract-text.mjs';
import {makeDocx,makeZip} from '../helpers/resume-files.mjs';
const parts={
 'word/document.xml':'<w:document xmlns:w="w" xmlns:r="r"><w:body><w:p><w:r><w:t>姓名</w:t><w:tab/><w:t>张三</w:t><w:br/><w:t>Java&#32;&#x5F00;发</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>学校</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>合成大学</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:headerReference r:id="rH"/></w:sectPr></w:body></w:document>',
 'word/_rels/document.xml.rels':'<Relationships><Relationship Id="rH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
 'word/header1.xml':'<w:hdr><w:p><w:r><w:t>test@example.com</w:t></w:r></w:p></w:hdr>',
 'word/header2.xml':'<w:hdr><w:p><w:r><w:t>UNREFERENCED</w:t></w:r></w:p></w:hdr>'
};
test('docx preserves inline separators numeric entities tables and referenced header',async()=>{
  const r=await extractResumeText(makeDocx(parts),'sample.docx');
  assert.match(r.text,/姓名\s+张三\s+Java 开发/);assert.match(r.text,/学校\s+合成大学/);
  assert.ok(r.text.includes('test@example.com'));assert.ok(!r.text.includes('UNREFERENCED'));
  assert.ok(Array.isArray(r.warnings));assert.ok(r.parserVersion);
});
test('zip rejects corrupt offsets unsupported compression and actual expansion limits',async()=>{
  const {readZipEntries}=await import('../../src/resume/zip.mjs');
  const bad=makeDocx(parts);bad.writeUInt32LE(0xFFFFFF00,bad.length-6);
  assert.throws(()=>readZipEntries(bad),/ZIP|offset|directory/i);
  assert.throws(()=>readZipEntries(makeZip({'word/document.xml':'x'},{method:99})),/compression|method/i);
  assert.throws(()=>readZipEntries(makeZip({'word/document.xml':'a'.repeat(1000)}),{maxExpandedBytes:32}),/limit|size/i);
  assert.throws(()=>readZipEntries(makeZip({'../outside':'x'})),/path/i);
});
test('empty file and oversized resume remain rejected',async()=>{
  await assert.rejects(extractResumeText(Buffer.alloc(0),'x.docx'),/为空/);
  await assert.rejects(extractResumeText(Buffer.alloc(20*1024*1024+1),'x.docx'),/上限/);
});
