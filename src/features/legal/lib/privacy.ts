// New in R2e (M4). The privacy page's two lists are DATA the code owns: the processors this tree uses (data/processors.json) and the rights with the route or address that honours each (data/rights.json). A structure test
// (tests/legal/privacy.test.ts) fails when a processor is named here and absent from the code, when the code uses a processor or host this file does not classify, and when a right names a route that does not exist.
import { z } from "zod";

import processorsJson from "../data/processors.json";
import rightsJson from "../data/rights.json";

const evidence = z.object({ dependencies: z.array(z.string()).optional(), files: z.array(z.string()).optional(), hosts: z.array(z.string()).optional() });
const processor = z.object({ id: z.string(), name: z.string(), role: z.string(), data: z.string(), condition: z.string().optional(), evidence });
const how = z.union([z.object({ route: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/api\//) }), z.object({ page: z.string().startsWith("/") }), z.object({ address: z.string().includes("@"), note: z.string().optional() })]);

export const PROCESSORS = z.object({ processors: z.array(processor).min(1), libraries: z.array(z.string()), publicHosts: z.array(z.string()) }).parse(processorsJson);
export const RIGHTS = z.object({ contact: z.string().includes("@"), respondWithinDays: z.number().int().positive(), rights: z.array(z.object({ id: z.string(), label: z.string(), text: z.string(), how })).min(1) }).parse(rightsJson);
export type Right = (typeof RIGHTS.rights)[number];
