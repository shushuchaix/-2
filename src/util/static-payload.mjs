import {parse} from 'acorn';
const forbidden=new Set(['__proto__','prototype','constructor']);
export function parseStaticPayload(expression,{maxBytes=1048576,maxNodes=50000,maxDepth=100}={}){
  if(typeof expression!=='string'||Buffer.byteLength(expression)>maxBytes)throw new Error('Payload size limit');
  const program=parse('('+expression.trim().replace(/;\s*$/,'')+')',{ecmaVersion:'latest'});
  if(program.body.length!==1||program.body[0].type!=='ExpressionStatement')throw new Error('Expected data expression');
  const stack=[[program,0]];let count=0;
  while(stack.length){
    const [node,depth]=stack.pop();if(++count>maxNodes||depth>maxDepth)throw new Error('Payload AST depth/node limit');
    for(const value of Object.values(node)){
      if(Array.isArray(value)){
        for(const item of value)if(item&&typeof item.type==='string')stack.push([item,depth+1]);
      }else if(value&&typeof value.type==='string')stack.push([value,depth+1]);
    }
  }
  function read(node,env,depth=0){
    if(!node||depth>maxDepth)throw new Error('Payload depth limit');
    switch(node.type){
      case 'Literal':
        if(node.regex||typeof node.value==='bigint')throw new Error('Non JSON literal');
        return node.value;
      case 'Identifier':
        if(env.has(node.name))return env.get(node.name);
        if(node.name==='undefined')return undefined;
        throw new Error('Unbound data identifier');
      case 'ArrayExpression':
        return node.elements.map(item=>item?read(item,env,depth+1):null);
      case 'ObjectExpression': {
        const result={};
        for(const property of node.properties){
          if(property.type!=='Property'||property.kind!=='init'||property.method||property.computed)throw new Error('Active object property');
          const key=property.key.type==='Identifier'?property.key.name:property.key.value;
          if(typeof key!=='string'&&typeof key!=='number')throw new Error('Invalid object key');
          if(forbidden.has(String(key)))throw new Error('Forbidden prototype key');
          Object.defineProperty(result,key,{value:read(property.value,env,depth+1),enumerable:true,writable:true,configurable:true});
        }
        return result;
      }
      case 'UnaryExpression':{
        const value=read(node.argument,env,depth+1);
        if(node.operator==='void')return undefined;
        if(node.operator==='!'&&['number','boolean'].includes(typeof value))return !value;
        if(node.operator==='-'&&typeof value==='number')return -value;
        if(node.operator==='+'&&typeof value==='number')return value;
        throw new Error('Unsupported unary data');
      }
      case 'CallExpression': {
        const fn=node.callee;
        if(fn.type!=='FunctionExpression'||fn.async||fn.generator||node.optional)throw new Error('Function calls forbidden');
        if(fn.params.some(p=>p.type!=='Identifier')||new Set(fn.params.map(p=>p.name)).size!==fn.params.length)throw new Error('Invalid parameter binding');
        const bound=new Map(env);
        const values=node.arguments.map(arg=>read(arg,env,depth+1));
        fn.params.forEach((p,i)=>bound.set(p.name,values[i]));
        let returned=false,result;
        for(const statement of fn.body.body){
          if(returned)throw new Error('Statements after return forbidden');
          if(statement.type==='EmptyStatement')continue;
          if(statement.type==='VariableDeclaration'){
            for(const declaration of statement.declarations){
              if(declaration.id.type!=='Identifier'||!declaration.init)throw new Error('Invalid data declaration');
              bound.set(declaration.id.name,read(declaration.init,bound,depth+1));
            }
          }else if(statement.type==='ReturnStatement'){
            result=read(statement.argument,bound,depth+1);returned=true;
          }else throw new Error('Active statement forbidden');
        }
        if(!returned)throw new Error('Missing data return');
        return result;
      }
      default:throw new Error('Unsupported data syntax: '+node.type);
    }
  }
  return read(program.body[0].expression,new Map());
}
