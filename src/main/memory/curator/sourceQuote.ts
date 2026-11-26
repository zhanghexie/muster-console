/** Only presentation-equivalent whitespace and quotation marks may change in a quote. */
const quoteMark = (character:string):string => /[‘’‚‛＇]/.test(character) ? "'" : /[“”„‟＂]/.test(character) ? '"' : character;

export interface SourceQuoteMatch { text:string; offset:number; end:number }
interface IndexedText { text:string; starts:number[]; ends:number[] }
function indexedText(source:string):IndexedText {
  const characters:string[]=[],starts:number[]=[],ends:number[]=[];
  for(let index=0;index<source.length;index++){
    const character=source[index];
    if(/\s/.test(character)){
      if(characters.at(-1)===' '){ends[ends.length-1]=index+1;continue;}
      characters.push(' ');
    }else characters.push(quoteMark(character));
    starts.push(index);ends.push(index+1);
  }
  return {text:characters.join(''),starts,ends};
}
export function normalizeQuoteFormatting(text:string):string {return indexedText(text).text.trim();}

/** Return raw source offsets, never reconstructed or semantically similar text. */
export function findSourceQuotes(source:string,quote:string,limit=3):SourceQuoteMatch[] {
  const sought=normalizeQuoteFormatting(quote);
  if(!sought||limit<1)return [];
  const indexed=indexedText(source),matches:SourceQuoteMatch[]=[];
  for(let index=indexed.text.indexOf(sought);index>=0&&matches.length<limit;index=indexed.text.indexOf(sought,index+1)){
    const offset=indexed.starts[index],end=indexed.ends[index+sought.length-1];
    matches.push({text:source.slice(offset,end),offset,end});
  }
  return matches;
}
export function findSourceQuote(source:string,quote:string):SourceQuoteMatch|undefined {
  if(!quote.trim())return undefined;
  const offset=source.indexOf(quote);
  return offset<0?findSourceQuotes(source,quote,1)[0]:{text:quote,offset,end:offset+quote.length};
}
