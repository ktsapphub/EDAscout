-- Default source list: Bretton's sources + recommended sources.
-- Sources that need a Phase 2 API connector, or whose exact page is unconfirmed, start paused (active=0) and can be switched on in /admin.

INSERT OR IGNORE INTO sources (name, url, tier, method, cadence, tags, kind, keyword_filter, link_pattern, origin, active) VALUES
-- Tier 1: Norfolk core (daily)
('Norfolk EDA (agendas & minutes)', 'https://norfolkdevelopment.com/target-industries/the-norfolk-economic-development-authority/', 1, 'html', 'daily', 'EDA,Meetings', 'meetings', NULL, '\.pdf($|\?)', 'yours', 1),
('Norfolk Development (home)', 'https://norfolkdevelopment.com/', 1, 'html', 'daily', 'EDA,Announcements', 'news', NULL, NULL, 'yours', 1),
('Norfolk Development business blog', 'https://norfolkdevelopment.com/feed/', 1, 'rss', 'daily', 'Expansions,Openings', 'news', NULL, NULL, 'recommended', 1),
('Norfolk Target Industries', 'https://norfolkdevelopment.com/target-industries/', 1, 'html', 'weekly', 'Industries', 'context', NULL, NULL, 'yours', 1),
('City Council & boards (iQM2)', 'https://norfolkcityva.iqm2.com/citizens/default.aspx', 1, 'html', 'daily', 'City Hall,Meetings', 'cityhall', 'City Council,Planning Commission,Economic Development Authority,Redevelopment and Housing,Architectural Review,Wetlands Board,St. Paul', 'Detail_Meeting\.aspx', 'yours', 1),
('Downtown Norfolk commercial real estate', 'https://www.downtownnorfolk.org/business/commercial-real-estate', 1, 'html', 'daily', 'Real Estate,Downtown', 'properties', NULL, NULL, 'yours', 1),
('Downtown Norfolk business directory', 'https://www.downtownnorfolk.org/business/business-directory', 1, 'html', 'weekly', 'Downtown,Businesses', 'news', NULL, NULL, 'yours', 1),
('Port Infrastructure Development Program (PIDP)', 'https://www.transportation.gov/rural/grant-toolkit/port-infrastructure-development-program-pidp', 1, 'html', 'weekly', 'Grants,Maritime', 'grants', NULL, NULL, 'yours', 1),
('Norfolk Innovation Corridor', 'https://downtownnorfolk.org/go/norfolk-innovation-corridor', 1, 'html', 'weekly', 'Innovation Corridor,Startups', 'news', NULL, NULL, 'recommended', 1),
('Norfolk Redevelopment and Housing Authority', 'https://www.nrha.us/', 1, 'html', 'daily', 'Redevelopment,St. Paul''s', 'news', NULL, NULL, 'recommended', 1),
('WAVY Norfolk news', 'https://www.wavy.com/feed/', 1, 'rss', 'daily', 'Local news', 'news', 'Norfolk', NULL, 'recommended', 1),
('Coastal Virginia Magazine', 'https://covabizmag.com/feed/', 1, 'rss', 'daily', 'Local business news', 'news', 'Norfolk', NULL, 'recommended', 1),
('Norfolk Open Data Portal', 'https://data.norfolk.gov/', 1, 'html', 'weekly', 'Permits,Property sales', 'properties', NULL, NULL, 'recommended', 0),
('Norfolk GIS parcels', 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData/Property_Information_Group_OpenData/MapServer/2', 1, 'html', 'weekly', 'Parcels', 'properties', NULL, NULL, 'recommended', 0),
('Grants.gov (Norfolk-eligible)', 'https://www.grants.gov/', 1, 'html', 'daily', 'Grants', 'grants', NULL, NULL, 'recommended', 0),
('Norfolk Planning Department', 'https://www.norfolk.gov/planning', 1, 'html', 'daily', 'Zoning,Site plans', 'cityhall', NULL, NULL, 'recommended', 0),
-- Tier 2: Norfolk plans + Hampton Roads context
('NFK2050 Comprehensive Plan', 'https://www.norfolk.gov/6551/Adopted-Plan', 2, 'html', 'monthly', 'Strategy,NFK2050', 'context', NULL, NULL, 'yours', 1),
('Inclusive Economic Development Strategy', 'https://www.norfolk.gov/DocumentCenter/View/64512/Norfolk-Economic-Development-Strategy', 2, 'pdf', 'monthly', 'Strategy', 'context', NULL, NULL, 'yours', 1),
('Port of Virginia: infrastructure & workforce', 'https://www.portofvirginia.com/the-future/economic-development/infrastructure-workforce/', 2, 'html', 'weekly', 'Maritime,Port', 'news', NULL, NULL, 'yours', 1),
('Hampton Roads Playbook (exec summary)', 'https://hamptonroadsplaybook.com/wp-content/uploads/2025/10/Hampton-Roads-Playbook-Executive-Summary.pdf', 2, 'pdf', 'monthly', 'Strategy,Regional', 'context', NULL, NULL, 'yours', 1),
('Hampton Roads Alliance CEDS', 'https://hamptonroadsalliance.com/ceds/', 2, 'html', 'weekly', 'Regional,Strategy', 'context', NULL, NULL, 'yours', 1),
('ODU State of the Region 2026', 'https://digitalcommons.odu.edu/sor_reports/229/', 2, 'html', 'monthly', 'Regional,Forecast', 'context', NULL, NULL, 'yours', 1),
('ODU State of the Commonwealth', 'https://www.odu.edu/article/state-of-the-commonwealth-report-old-dominion-university-economists-examine-effects-of', 2, 'html', 'monthly', 'Statewide', 'context', NULL, NULL, 'yours', 1),
('Virginia Business', 'https://virginiabusiness.com/feed/', 2, 'rss', 'daily', 'Statewide deals', 'news', 'Norfolk,Hampton Roads', NULL, 'recommended', 1),
('VEDP announcements', 'https://www.vedp.org/news', 2, 'html', 'weekly', 'State deals', 'news', 'Norfolk,Hampton Roads', NULL, 'recommended', 1),
('Norfolk Airport (ORF)', 'https://www.norfolkairport.com/', 2, 'html', 'monthly', 'Airport', 'news', NULL, NULL, 'recommended', 1),
('HRTPO', 'https://www.hrtpo.org/', 2, 'html', 'weekly', 'Transportation', 'news', NULL, NULL, 'recommended', 1),
('Hampton Roads Chamber', 'https://www.hrchamber.com/', 2, 'html', 'weekly', 'Business community', 'news', NULL, NULL, 'recommended', 1),
('HRMFFA (military & federal facilities)', 'https://www.hrmffa.org/', 2, 'html', 'weekly', 'Federal/Defense', 'news', NULL, NULL, 'recommended', 1),
('BLS / FRED metro jobs data', 'https://fred.stlouisfed.org/', 2, 'html', 'monthly', 'Jobs,Metrics', 'context', NULL, NULL, 'recommended', 0),
('Virginia Employment Commission data', 'https://virginiaworks.com/', 2, 'html', 'monthly', 'Jobs,Metrics', 'context', NULL, NULL, 'recommended', 0),
-- Tier 3: Southeast + trends (context, never Norfolk news)
('Atlanta Fed Beige Book (Oct 14, 2026)', 'https://www.atlantafed.org/what-we-study/regional-economy/beige-book/2026/10/14/beige-book-glp-1s-affecting-demand-for-poultry-alcohol', 3, 'html', 'monthly', 'Southeast', 'context', NULL, NULL, 'yours', 1),
('Atlanta Fed Regional Economy', 'https://www.atlantafed.org/what-we-study/regional-economy', 3, 'html', 'weekly', 'Southeast', 'context', NULL, NULL, 'yours', 1),
('Richmond Fed regional economy', 'https://www.richmondfed.org/region_communities/regional_data_analysis', 3, 'html', 'monthly', 'Virginia', 'context', NULL, NULL, 'recommended', 1),
('Site Selectors Guild 2025', 'https://siteselectorsguild.com/research/state-of-site-selection-2025/', 3, 'html', 'monthly', 'Trends', 'context', NULL, NULL, 'yours', 1),
('Brookings: Mapping the AI Economy', 'https://www.brookings.edu/articles/mapping-the-ai-economy-which-regions-are-ready-for-the-next-technology-leap/', 3, 'html', 'monthly', 'Trends,AI', 'context', NULL, NULL, 'yours', 1),
('PwC Site Selection & Labor', 'https://www.pwc.com/us/en/services/audit-assurance/library/us-site-selection-labor-dynamics.html', 3, 'html', 'monthly', 'Trends,Labor', 'context', NULL, NULL, 'yours', 1),
('WEF Future of Jobs 2025', 'https://www.weforum.org/publications/the-future-of-jobs-report-2025/in-full/2-jobs-outlook/', 3, 'html', 'monthly', 'Trends,Workforce', 'context', NULL, NULL, 'yours', 1);

-- Default model routes: cheapest first. Workers AI needs no key; third-party entries are skipped until their key is added.
INSERT OR IGNORE INTO model_routes (task, chain, max_tokens, daily_cap_calls) VALUES
('summarize', '[{"provider":"workers-ai","model":"@cf/meta/llama-3.1-8b-instruct-fast"},{"provider":"workers-ai","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"},{"provider":"openai-compat","base_url":"https://generativelanguage.googleapis.com/v1beta/openai","model":"gemini-2.5-flash","key":"GEMINI_API_KEY"}]', 900, 40),
('extract', '[{"provider":"workers-ai","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"},{"provider":"openai-compat","base_url":"https://generativelanguage.googleapis.com/v1beta/openai","model":"gemini-2.5-flash","key":"GEMINI_API_KEY"},{"provider":"openai-compat","base_url":"https://api.openai.com/v1","model":"gpt-5-mini","key":"OPENAI_API_KEY"}]', 1200, 12),
('synthesize', '[{"provider":"workers-ai","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"},{"provider":"openai-compat","base_url":"https://generativelanguage.googleapis.com/v1beta/openai","model":"gemini-2.5-flash","key":"GEMINI_API_KEY"}]', 700, 6),
('voice', '[{"provider":"workers-ai","model":"@cf/meta/llama-3.1-8b-instruct-fast"}]', 250, 100);
