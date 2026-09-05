import 'dotenv/config';
import path from 'node:path';
import type { Journal } from './types.js';
export const ROOT = path.resolve(process.env.PAPER_MONITOR_ROOT || process.cwd());
export const COVERAGE_START = '2025-01-01';
export const OUTPUT = path.join(ROOT, 'output');
export const STATE = path.join(ROOT, '.state');
export const LIBRARY_PATH = path.join(OUTPUT, 'library.json');
export const JOURNALS: Journal[] = [
 { id:'bjet', name:'British Journal of Educational Technology', shortName:'BJET', issn:'1467-8535', publisher:'wiley', url:'https://bera-journals.onlinelibrary.wiley.com/journal/14678535', feeds:['https://bera-journals.onlinelibrary.wiley.com/feed/14678535/most-recent'] },
 { id:'berj', name:'British Educational Research Journal', shortName:'BERJ', issn:'1469-3518', publisher:'wiley', url:'https://bera-journals.onlinelibrary.wiley.com/journal/14693518', feeds:['https://bera-journals.onlinelibrary.wiley.com/feed/14693518/most-recent'] },
 { id:'compedu', name:'Computers & Education', shortName:'C&E', issn:'0360-1315', publisher:'elsevier', url:'https://www.sciencedirect.com/journal/computers-and-education', feeds:['https://rss.sciencedirect.com/publication/science/03601315'] },
 { id:'jla', name:'Journal of Learning Analytics', shortName:'JLA', issn:'1929-7750', publisher:'jla', url:'https://learning-analytics.info/index.php/JLA', feeds:['https://learning-analytics.info/index.php/JLA/oai'] },
 { id:'rer', name:'Review of Educational Research', shortName:'RER', issn:'1935-1046', publisher:'sage', url:'https://journals.sagepub.com/home/rer', feeds:['https://journals.sagepub.com/action/showFeed?feed=rss&jc=rer&type=axatoc','https://journals.sagepub.com/action/showFeed?feed=rss&jc=rer&type=etoc'] },
 { id:'edurev', name:'Educational Research Review', shortName:'ERR', issn:'1747-938X', publisher:'elsevier', url:'https://www.sciencedirect.com/journal/educational-research-review', feeds:['https://rss.sciencedirect.com/publication/science/1747938X'] },
 { id:'caeai', name:'Computers and Education: Artificial Intelligence', shortName:'C&E: AI', issn:'2666-920X', publisher:'elsevier', url:'https://www.sciencedirect.com/journal/computers-and-education-artificial-intelligence', feeds:['https://rss.sciencedirect.com/publication/science/2666920X'] }
];
export function credentialStatus() { return { elsevier: Boolean(process.env.ELSEVIER_API_KEY), openalex: Boolean(process.env.OPENALEX_API_KEY), contactEmail: Boolean(process.env.CONTACT_EMAIL) }; }
