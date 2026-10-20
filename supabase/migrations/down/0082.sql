-- Down for 0082_licence_register_r2g: the nine data_sources rows R2g seeded go.
DELETE FROM public.data_sources WHERE source_key IN ('ghgprotocol_org', 'ecotransit_org', 'consilium_europa_eu', 'ec_climate_europa_eu', 'ec_taxation_customs_europa_eu', 'mardep_gov_hk', 'icao_int', 'mcga_gov_uk', 'cbp_gov');
