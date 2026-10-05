import {el} from './dom.js';
export function feedback(document){const node=el(document,'div',{'aria-live':'polite',className:'feedback'});return {node,show(text,error=false){node.textContent=text;node.className=error?'feedback error':'feedback';node.setAttribute('role',error?'alert':'status');}};}
