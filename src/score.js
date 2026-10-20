// Rules-first scoring (0–100). Clear cases never need a model; the model only nudges the ambiguous 30–70 band.

const PLACES = ['downtown norfolk', 'waterside', 'macarthur', 'ghent', 'wards corner', "st. paul's", 'st paul', 'military circle', 'harbor park',
  'fort norfolk', 'neon district', 'ocean view', 'east beach', "lambert's point", 'greyhound', 'granby street', 'norfolk international terminals',
  'old dominion', 'odu', 'norfolk state', 'nsu', 'evms', 'sentara', 'chkd', 'naval station norfolk', 'norfolk naval', 'innovation corridor',
  'park place', 'broad creek', 'campostella', 'brambleton', 'church street', 'little creek', 'norfolk premium outlets', 'tidewater drive'];
const BODIES = ['economic development authority', ' eda ', 'city council', 'planning commission', 'redevelopment and housing', 'nrha',
  'architectural review', 'board of zoning', 'department of economic development'];

export const INDUSTRIES = {
  'Maritime & Logistics': ['port', 'maritime', 'shipping', 'logistics', 'terminal', 'container', 'shipyard', 'ship repair', 'freight', 'warehouse', 'subsea', 'offshore wind'],
  'Advanced Mfg': ['manufactur', 'fabricat', 'robotic', 'assembly', 'industrial', 'production facility'],
  'Health/Bio': ['health', 'hospital', 'medical', 'biotech', 'life science', 'clinic', 'cardiac', 'pharma'],
  'Professional Services': ['headquarters', 'office', 'consulting', 'financial services', 'law firm', 'professional services', 'fintech'],
  'Real Estate': ['real estate', 'property', 'properties', 'square feet', 'sq ft', 'sq. ft', 'lease', 'parcel', 'rezoning', 'zoning', 'redevelop', 'mixed-use', 'apartment', 'retail space', 'site plan', 'mall'],
  'Workforce': ['workforce', 'jobs', 'hiring', 'apprentice', 'training', 'talent', 'employment'],
  'Federal/Defense': ['navy', 'naval', 'defense', 'military', 'federal', 'dod', 'contract award'],
  'Grants': ['grant', 'nofo', 'funding opportunity', 'award', 'appropriat'],
  'Tourism & Arts': ['tourism', 'hotel', 'arts', 'festival', 'venue', 'casino', 'convention'],
  'Startups & Tech': ['startup', 'accelerator', 'innovation', 'tech company', 'ai ', 'software', 'cyber'],
};

const MONEY = /\$\s?\d[\d,.]*\s?(million|billion|m\b|k\b)?/i;
const JOBS = /\b\d[\d,]*\s+(new\s+)?(jobs|positions|employees)\b/i;
const SQFT = /\b\d[\d,]*\s*(square[- ]feet|sq\.?\s?ft)\b/i;
const ACTION = /\b(approv(e|ed|al)|vote[ds]?|award(ed)?|invest(s|ed|ment)|expan(d|ds|sion)|relocat|groundbreak|ribbon[- ]cutting|open(s|ing)? (its|a|new)|announc(e|es|ed)|acquir|purchase[ds]?|break ground|incentive|resolution|ordinance|rezon)/i;
const DEADLINE = /\b(deadline|due (date|by)|applications? (are )?due|closes on|apply by)\b/i;

export function scoreItem({ title = '', text = '', publishedAt, sourceTier = 1, kind = 'news' }) {
  const t = ` ${(title + ' ' + text).toLowerCase()} `;
  const hits = [];
  let norfolk = 0;
  if (t.includes('norfolk')) norfolk += 15;
  if (sourceTier === 1) norfolk += 8;
  const places = PLACES.filter(p => t.includes(p));
  norfolk += Math.min(places.length * 6, 12);
  if (BODIES.some(b => t.includes(b))) { norfolk += 10; hits.push('public body'); }
  norfolk = Math.min(norfolk, 30);

  const tags = [];
  for (const [tag, words] of Object.entries(INDUSTRIES)) if (words.some(w => t.includes(w))) tags.push(tag);
  const industry = Math.min(tags.length * 9, 25);

  let material = 0;
  if (MONEY.test(t)) { material += 10; hits.push('dollar amount'); }
  if (JOBS.test(t)) { material += 8; hits.push('jobs'); }
  const sq = t.match(SQFT);
  if (sq) { material += 6; if (Number(sq[0].replace(/[^\d]/g, '')) >= 20000) hits.push('large property'); }
  if (ACTION.test(t)) { material += 9; hits.push('decision/announcement'); }
  if (kind === 'meetings') material += 6;
  material = Math.min(material, 25);

  let timely = 12;
  if (publishedAt) {
    const days = (Date.now() - Date.parse(publishedAt)) / 864e5;
    timely = days <= 2 ? 20 : days <= 7 ? 14 : days <= 30 ? 6 : 0;
  }
  if (DEADLINE.test(t)) { timely = Math.min(20, timely + 6); hits.push('deadline'); }

  // Context sources (plans, Fed, trend reports) never outrank Norfolk news.
  let score = norfolk + industry + material + timely;
  if (kind === 'context') score = Math.min(score, 45);
  return { score: Math.max(0, Math.min(100, score)), tags: tags.slice(0, 3), hits, places };
}

/** Watch rules that make an item a signal regardless of score. */
export function watchRule({ hits, kind, title = '' }) {
  if (kind === 'meetings' && /minutes|agenda/i.test(title)) return 'EDA meeting document';
  if (hits.includes('large property')) return 'Property ≥ 20,000 sq ft';
  if (hits.includes('deadline') && hits.includes('dollar amount')) return 'Funding deadline';
  if (hits.includes('public body') && hits.includes('decision/announcement')) return 'Public body decision';
  return null;
}
