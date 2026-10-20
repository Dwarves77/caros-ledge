// Ported from old_repo/src/lib/sources/classify-source-role.ts (lines 1-111)
// Ported from old_repo/src/lib/sources/vertical-fit.ts (lines 1-73)
// Ported from old_repo/src/lib/sources/source-type-taxonomy.mjs (lines 1-198)

import { hostOf } from "@/core/shared";

export type SourceRole =
  | "primary_legal_authority"
  | "government_press"
  | "intergovernmental_body"
  | "standards_body"
  | "academic_research"
  | "trade_press"
  | "statistical_data_agency"
  | "vendor_corporate"
  | "industry_association"
  | "industry_data_provider";

const GOV_HOST = (host: string): boolean =>
  /\.gov$/.test(host) || /(^|\.)gov\.[a-z]{2}(\.[a-z]{2})?$/.test(host) || /\.govt\.[a-z]{2}$/.test(host) || /\.gob\.[a-z]{2}$/.test(host) || /\.gc\.ca$/.test(host) || /\.go\.[a-z]{2}$/.test(host) || /\.gouv\./.test(host) || /(^|\.)parliament\./.test(host);

/** The deterministic source_role from the stored name and URL; null when undeterminable (a flag, never a guess). The host outranks name keywords. */
export function classifySourceRole(name: string | null | undefined, url: string | null | undefined): SourceRole | null {
  const n = (name || "").toLowerCase();
  const host = hostOf(url);
  const tld = host.split(".").slice(-1)[0] || "";

  // 1. Intergovernmental bodies (supranational, before national government).
  if (
    /\b(imo|icao|unctad|unfccc|\bunep\b|\bun\b|united nations|oecd|\biea\b|irena|world bank|\bwto\b|ipcc|itf-oecd|international transport forum|international energy agency|international maritime|international civil aviation)\b/.test(n) ||
    /(^|\.)(imo|icao|unctad|oecd|irena|iea|wto|ipcc|unfccc|unep|undp|unesco|un)\.org$/.test(host) ||
    host.endsWith(".int")
  )
    return "intergovernmental_body";

  // 2. Standards and target-setting bodies (before academic: SBTi and ISO are not universities).
  if (/\b(\biso\b|ghg protocol|greenhouse gas protocol|\bglec\b|smart freight|science based targets|sbti|sbtn|\bcdp\b|ifrs|issb|breeam|\bgri\b|global reporting initiative|ecovadis|sustainable packaging coalition)\b/.test(n)) return "standards_body";

  // A government, EU or intergovernmental host settles identity: it is barred from the two keyword-only rules below.
  const strongInstitutionalHost = GOV_HOST(host) || /\.int$/.test(host) || /(^|\.)europa\.eu$/.test(host) || /(^|\.)un\.org$/.test(host) || /(^|\.)unesco\.org$/.test(host);

  // 3. Academic and research institutes.
  if (
    !strongInstitutionalHost &&
    (/\.(edu)$/.test(host) ||
      /\.ac\.[a-z]{2}$/.test(host) ||
      /\b(universit|institute|institut|\bcentre\b|\bcenter\b|laborator|\blab\b|fraunhofer|tyndall|chalmers|cranfield|erasmus|stockholm environment|world resources institute|carbon trust|project drawdown)\b/.test(n))
  )
    return "academic_research";

  // 4. Statistical and data agencies (before generic government: EIA is a data agency).
  if (/\b(energy information administration|\beia\b|statistics|statistical|data portal|open data|data api|nsrdb|pvwatts)\b/.test(n)) return "statistical_data_agency";

  // 5. Government and legal authority. Bare "Government" counts only on a non-commercial origin.
  if (
    GOV_HOST(host) ||
    /(^|\.)(novascotia|ontario|quebec|alberta|saskatchewan|manitoba)\.ca$/.test(host) ||
    /(^|\.)europa\.eu$/.test(host) ||
    /\b(government of|gouvernement|governo do|gobierno de)\b/.test(n) ||
    (/\bgovernment\b/.test(n) && !["com", "co", "io", "ai", "net", "law"].includes(tld) && !/\.(com|co)\.[a-z]{2}$/.test(host)) ||
    /\b(ministry|ministerio|minist[èe]re|ministerstv|department of|parliament|legislature|congress|senate|national assembly|chamber of deputies|house of (representatives|councillors|commons|lords)|federal register|eur-lex|legislation|official journal|secretariat of|environmental protection agenc|\bepa\b|regulatory authority)\b/.test(n)
  )
    return "primary_legal_authority";

  // 6. Trade press and news ("news", "press" are document-title words, so an institutional host is barred).
  if (!strongInstitutionalHost && /\b(freightwaves|loadstar|splash247|lloyd'?s list|journal of commerce|\bjoc\b|tradewinds|greenbiz|\bedie\b|environmental finance|supply chain digital|bloomberg|reuters|news|newsletter|magazine|\bpress\b|gazette of)\b/.test(n)) return "trade_press";

  // 7. Industry associations (.asn.xx is a reserved association domain).
  if (!strongInstitutionalHost && (/\.asn\.[a-z]{2}$/.test(host) || /\b(association|alliance|coalition|\bcouncil\b|federation|chamber of (commerce|shipping)|consortium|\bfiata\b|\bclecat\b|\biata\b|\bcsa\b|\bicct\b)\b/.test(n))) return "industry_association";

  // 8. Data providers, vendors and corporates.
  if (/\b(\bdnv\b|bureau veritas|\babs\b|classnk|lloyd'?s register|thomson reuters|j\.?p\.? ?morgan|bloombergnef|wood mackenzie|s&p global|consult|advisory|\bltd\b|\binc\b|gmbh|corporation|\bplc\b)\b/.test(n))
    return /\bbloombergnef|wood mackenzie|s&p global|data\b/.test(n) ? "industry_data_provider" : "vendor_corporate";
  // .eu is an EU-level institutional domain here, never commercial.
  if (tld === "eu") return "industry_association";
  if (["com", "co", "io", "ai", "law"].includes(tld) || /\.(com|co)\.[a-z]{2}$/.test(host)) return "vendor_corporate";
  return null;
}

export type InstitutionalType = "statute_gazette_db" | "general_legislature" | "sectoral_regulator_ministry" | "intergovernmental" | "standards_body" | "academic_research" | "statistical_data_agency" | "industry" | "unknown";

const GAZETTE_STATUTE_DB = /\b(gazette|official journal|eur-?lex|federal register|code of federal regulations|statutes?\s*(online|of)|statute law|legislation(\.gov)?|laws?\s+and\s+regulations|law database|legal database|national database of laws|e-?gazette|e-?laws?|elaw|di[áa]rio oficial|bolet[íi]n oficial|gazzetta ufficiale|journal officiel|amtsblatt)\b|官報/i;
const GENERAL_LEGISLATURE =
  /\b(legislative assembly|legislature|metropolitan assembly|national assembly|general assembly|provincial assembly|state assembly|parliament(ary)?|house of representatives|house of councillors|house of commons|house of lords|chamber of deputies|national council|city council|county council|\bcongress\b|\bsenate\b|\bbundestag\b|\bbundesrat\b|\bnationalrat\b|\briksdag\b|\bfolketing\b|\bsejm\b|cortes generales|asamblea nacional|assembl[ée]e nationale|\bduma\b|\bknesset\b|\bstorting\b|eduskunta|tweede kamer|oireachtas|\bsaeima\b|\bseimas\b|riigikogu|dr[žz]avni zbor|n[áa]rodn[áa] rada|verkhovna rada|lok sabha|rajya sabha)\b|議会|国会|衆議院|参議院|都議会/i;
const SECTORAL_REGULATOR_MINISTRY = /\b(ministry|ministerio|minist[èe]re|ministerstv\w*|department of|dept\.?\s+of|\bagency\b|administration|\bauthority\b|commission|\bbureau\b|directorate|secretariat|inspectorate|regulator|\bepa\b|environmental protection|civil aviation|maritime|customs|port authority|transport)\b/i;

/** The institutional identity of a source from its name (the role is a weak prior). Deterministic; unknown means review, never auto-kill. */
export function classifyInstitutionalType(name: string | null | undefined, sourceRole?: SourceRole | null | undefined): InstitutionalType {
  const n = (name || "").trim();
  switch (sourceRole) {
    case "intergovernmental_body":
      return "intergovernmental";
    case "standards_body":
      return "standards_body";
    case "academic_research":
      return "academic_research";
    case "statistical_data_agency":
      return "statistical_data_agency";
    case "trade_press":
    case "industry_association":
    case "industry_data_provider":
    case "vendor_corporate":
      return "industry";
    default:
      break;
  }
  if (GAZETTE_STATUTE_DB.test(n)) return "statute_gazette_db";
  if (GENERAL_LEGISLATURE.test(n)) return "general_legislature";
  if (SECTORAL_REGULATOR_MINISTRY.test(n)) return "sectoral_regulator_ministry";
  return "unknown";
}

/** Off-vertical BY IDENTITY: a general legislature. Never authorizes a kill by itself (the coverage guard is the caller's). */
export const isOffVerticalByIdentity = (type: InstitutionalType): boolean => type === "general_legislature";

const ENV_BODY_PATTERNS = [
  /\bepa\b/i, /environment(al)?/i, /ecolog\w*/i, /climate/i, /eccc\b/i, /\bdefra\b/i, /\beea\b/i,
  /\bdec\.[a-z.-]+\.gov\b/i, /\bdeep\.[a-z.-]+\.gov\b/i, /\bdeq\.[a-z.-]+\.gov\b/i, /natural[- ]?resources?/i, /conservation/i,
  /\bumweltbundesamt\b/i, /\bumwelt\b/i, /\bnaturv[åa]rdsverket\b/i, /\bymp[äa]rist[öo]\b/i, /\bmilj[øo]\b/i, /\bmilieu\b/i, /\bmedio[- ]ambiente\b/i, /\bambiente\b/i,
  /\bministerio[- ]?(?:del|de la|de)?\s*(?:medio[- ]ambiente|ambiente|ecolog[íi]a)/i,
  /\bminist[èe]re[- ]?(?:de l['’])?\s*(?:environnement|[ée]cologie|transition[- ]?[ée]cologique)/i,
  /\bmoe\.[a-z.-]+/i, /\bmee\.[a-z.-]+/i, /\benv\.[a-z.-]+/i,
];
// The CJK names carry no \b: it needs an ASCII word character beside the run and so never matched them. legifrance is a gazette, not a legislature.
const LEGISLATURE_PATTERNS = [
  /legis/i, /parliament/i, /assembly/i, /senate/i, /congress/i, /house of (?:commons|representatives|lords)/i,
  /\bbundestag\b/i, /\bbundesrat\b/i, /\bnationalrat\b/i, /\bduma\b/i, /\bdiet\b/i, /\briksdag\b/i, /\bfolketing\b/i, /\bstorting\b/i, /\beduskunta\b/i, /\bseimas\b/i, /\bsaeima\b/i, /\briigikogu\b/i, /\bcortes\b/i, /\bd[áa]il\b/i, /\boireachtas\b/i,
  /\btweede[- ]?kamer\b/i, /\beerste[- ]?kamer\b/i, /\bstaten[- ]?generaal\b/i, /\bstortinget\b/i, /\bassembl[ée]e[- ]?nationale\b/i, /\bs[ée]nat\b/i, /\bcamera[- ]?dei[- ]?deputati\b/i, /\bassemblea\b/i, /\bc[áa]mara\b/i, /\bsejm\b/i,
  /國會/u, /国会/u, /국회/u,
  /\bparliament\.[a-z.-]+/i, /\bgov\.[a-z.-]+\b\/(?:parliament|legis|house)/i, /\blex\.[a-z]{2}\b/i,
];

/** Zero or more registered source_type tokens from name and URL (environmental_body, legislature). Pure; a source can match both. */
export function classifySourceType({ name, url }: { name?: string | null | undefined; url?: string | null | undefined } = {}): string[] {
  const text = `${name || ""} ${url || ""}`;
  const out: string[] = [];
  if (ENV_BODY_PATTERNS.some((re) => re.test(text))) out.push("environmental_body");
  if (LEGISLATURE_PATTERNS.some((re) => re.test(text))) out.push("legislature");
  return out;
}
