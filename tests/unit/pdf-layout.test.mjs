import test from 'node:test';
import assert from 'node:assert/strict';
import {extractResumeText} from '../../src/resume/extract-text.mjs';
const item=(str,x,y,width=110)=>({str,transform:[12,0,0,12,x,y],width,height:12});
const columns=[item('右栏第二行',330,690),item('左栏第一行',50,720),item('右栏第一行',330,720),item('左栏第二行',50,690)];
test('pdf shuffled columns and full width heading retain reading order',async()=>{
  const {orderPdfItems}=await import('../../src/resume/pdf-layout.mjs');
  assert.equal(orderPdfItems(columns,{width:600,height:800}).text,'左栏第一行\n左栏第二行\n右栏第一行\n右栏第二行');
  assert.equal(orderPdfItems([item('标题',40,770,520),...columns],{width:600,height:800}).text,'标题\n左栏第一行\n左栏第二行\n右栏第一行\n右栏第二行');
});
test('pdf empty text warns and overlapping layout is marked uncertain',async()=>{
  const {orderPdfItems}=await import('../../src/resume/pdf-layout.mjs');
  assert.ok(orderPdfItems([],{width:600,height:800}).warnings.includes('no_extractable_text'));
  assert.ok(orderPdfItems([item('A',40,720,350),item('B',200,720,300)],{width:600,height:800}).warnings.includes('reading_order_uncertain'));
});
function makePdf(){
  const content='BT /F1 12 Tf 1 0 0 1 330 720 Tm (RIGHT ONE) Tj 1 0 0 1 330 690 Tm (RIGHT TWO) Tj 1 0 0 1 50 720 Tm (LEFT ONE) Tj 1 0 0 1 50 690 Tm (LEFT TWO) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length '+Buffer.byteLength(content)+' >>\nstream\n'+content+'\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('');
  pdf+='trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return Buffer.from(pdf);
}
test('real synthetic pdf extraction reads left column before right',async()=>{
  const result=await extractResumeText(makePdf(),'two-columns.pdf');
  assert.equal(result.text,'LEFT ONE\nLEFT TWO\nRIGHT ONE\nRIGHT TWO');
  assert.ok(result.parserVersion);assert.ok(Array.isArray(result.warnings));
});
