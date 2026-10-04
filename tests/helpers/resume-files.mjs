import zlib from 'node:zlib';
export function makeZip(parts,{method=8}={}){
  const locals=[],centrals=[];let offset=0;
  for(const [name,value] of Object.entries(parts)){
    const n=Buffer.from(name),plain=Buffer.from(value),data=method===8?zlib.deflateRawSync(plain):plain;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(plain.length,22);local.writeUInt16LE(n.length,26);
    locals.push(local,n,data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt16LE(method,10);
    central.writeUInt32LE(data.length,20);central.writeUInt32LE(plain.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);
    centrals.push(central,n);offset+=local.length+n.length+data.length;
  }
  const cd=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(parts).length,8);end.writeUInt16LE(Object.keys(parts).length,10);
  end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);
}
export const makeDocx=parts=>makeZip(parts);
