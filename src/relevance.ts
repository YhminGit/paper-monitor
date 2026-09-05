import type { Paper, Relevance } from './types.js';
const AI = ['artificial intelligence','generative ai','genai','chatgpt','large language model','language models','machine learning','deep learning','neural network','intelligent tutor','ai literacy','ai-powered','ai-assisted','ai-supported','ai-generated','automated essay scoring','chatbot','learning analytics'];
const LA = ['learning analytics','educational data mining','learner analytics','academic analytics','multimodal analytics','curricular analytics','curriculum analytics','learning dashboard','learning trace','learning process data','student performance prediction','predicting student','knowledge tracing','clickstream','epistemic network analysis'];
export function isExcluded(p: Pick<Paper,'articleType'|'title'>) {
 const type=p.articleType.replace(/[-_]+/g,' ');
 const title=p.title.trim();
 return /\b(editorial|correction|corrigendum|erratum|retraction|retracted|withdrawn|withdrawal|announcement|book review)\b/i.test(type)
  || /^(?:\[\s*)?(correction( to)?|corrigendum|erratum|retraction|retracted|withdrawn|editorial|book review|call for papers)\b/i.test(title)
  || /^(?:\[\s*)?withdrawal(?:\s+notice)?(?=\s*[:：\]\-–—]|\s+(?:of|to)\b|$)/i.test(title);
}
export function classify(p: Pick<Paper,'title'|'abstract'|'keywords'|'articleType'|'journalId'>): Relevance {
 if(isExcluded(p)) return {topic:'unrelated',method:'rules',confidence:'high',reason:'Excluded publication type.',evidence:[]};
 const text=`${p.title} ${p.abstract||''} ${p.keywords.join(' ')}`.toLowerCase();
 const ai=AI.filter(x=>x!=='learning analytics' && text.includes(x));
 if(/\bai\b/i.test(p.title)) ai.push('AI in title');
 const la=LA.filter(x=>text.includes(x));
 // Journal scope supports recall; Codex still reviews individual relevance.
 if(p.journalId==='jla'&&!la.length) la.push('Journal of Learning Analytics scope');
 if(p.journalId==='caeai'&&!ai.length) ai.push('Computers and Education: Artificial Intelligence scope');
 const topic=ai.length&&la.length?'both':ai.length?'ai':la.length?'learning-analytics':'pending';
 return {topic,method:'rules',confidence:'low',reason:topic==='pending'?'Needs semantic review; no direct topic phrase found.':'Provisional topic match; awaiting semantic review.',evidence:[...la,...ai]};
}
export function relevant(p: Paper) { return !isExcluded(p) && ['both','learning-analytics','ai'].includes(p.relevance.topic); }
