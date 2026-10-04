export function orderPdfItems(items,{width=600}={}){
  const warnings=new Set();
  const blocks=items.filter(i=>typeof i.str==='string'&&i.str.trim()).map((i,index)=>{
    const t=i.transform||[1,0,0,1,0,0];
    if(Math.abs(t[1]||0)>0.1||Math.abs(t[2]||0)>0.1)warnings.add('reading_order_uncertain');
    return {text:i.str,x:Number(t[4])||0,y:Number(t[5])||0,width:Number(i.width)||0,height:Math.abs(Number(i.height)||Number(t[3])||12),index};
  });
  if(!blocks.length)return {text:'',warnings:['no_extractable_text']};
  const heights=blocks.map(i=>i.height).sort((a,b)=>a-b);
  const tolerance=Math.min(6,Math.max(2,heights[Math.floor(heights.length/2)]*0.4));
  function lines(group){
    const rows=[];
    for(const b of [...group].sort((a,b)=>b.y-a.y||a.x-b.x)){
      let row=rows.find(r=>Math.abs(r.y-b.y)<=tolerance);
      if(!row){row={y:b.y,items:[]};rows.push(row);}row.items.push(b);
    }
    return rows.sort((a,b)=>b.y-a.y).map(row=>{
      const ordered=row.items.sort((a,b)=>a.x-b.x||a.index-b.index);let text='',end=-Infinity;
      for(const b of ordered){
        if(b.x<end-3)warnings.add('reading_order_uncertain');
        const gap=b.x-end;
        text+=(text&&gap>Math.max(2,b.height*0.2)?' ':'')+b.text;end=Math.max(end,b.x+b.width);
      }
      return text.trim();
    }).filter(Boolean);
  }
  const body=blocks.filter(b=>b.width<width*0.65);
  const starts=[...new Set(body.map(b=>b.x))].sort((a,b)=>a-b);
  let split=null,gap=0;
  for(let i=1;i<starts.length;i++)if(starts[i]-starts[i-1]>gap){gap=starts[i]-starts[i-1];split=(starts[i]+starts[i-1])/2;}
  let output;
  const left=body.filter(b=>b.x<split),right=body.filter(b=>b.x>=split);
  const distinctRows=group=>new Set(group.map(b=>Math.round(b.y/tolerance))).size;
  const hasColumns=split!==null&&gap>Math.max(70,width*0.14)&&distinctRows(left)>=2&&distinctRows(right)>=2&&
    left.every(b=>b.x+b.width<split+10);
  if(hasColumns){
    const spanning=blocks.filter(b=>b.width>=width*0.65).sort((a,b)=>b.y-a.y);
    output=[];let remaining=body;
    for(const heading of spanning){
      const above=remaining.filter(b=>b.y>heading.y+tolerance);
      output.push(...lines(above.filter(b=>b.x<split)),...lines(above.filter(b=>b.x>=split)),heading.text);
      remaining=remaining.filter(b=>b.y<=heading.y+tolerance);
    }
    output.push(...lines(remaining.filter(b=>b.x<split)),...lines(remaining.filter(b=>b.x>=split)));
  }else output=lines(blocks);
  return {text:output.join('\n'),warnings:[...warnings]};
}
