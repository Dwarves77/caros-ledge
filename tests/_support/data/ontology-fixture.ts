// A snapshot of the entity spine as the seeds once wrote it, kept as test data only: the engine reads the database, never this.
export default {
 "entities": [
  {
   "key": "mode:air",
   "class": "mode",
   "name": "Air freight",
   "kind": "asset",
   "role": "cites_mode",
   "entityId": "cl:asset:2fd6ccdc874cab67",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "mode:ocean",
   "class": "mode",
   "name": "Ocean freight",
   "kind": "asset",
   "role": "cites_mode",
   "entityId": "cl:asset:52f1ba0e5a3e12c5",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "mode:road",
   "class": "mode",
   "name": "Road freight",
   "kind": "asset",
   "role": "cites_mode",
   "entityId": "cl:asset:b77d0e3c8b0c915c",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "mode:rail",
   "class": "mode",
   "name": "Rail freight",
   "kind": "asset",
   "role": "cites_mode",
   "entityId": "cl:asset:ef11d42b632123d0",
   "modes": [
    "rail"
   ],
   "unit": null
  },
  {
   "key": "mode:inland_waterway",
   "class": "mode",
   "name": "Inland waterway freight",
   "kind": "asset",
   "role": "cites_mode",
   "entityId": "cl:asset:32e6dd8e48c05b84",
   "modes": [
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "hub:seaport",
   "class": "hub",
   "name": "Seaport",
   "kind": "node",
   "role": "cites_hub",
   "entityId": "cl:node:808d1902f383b1c7",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "hub:airport",
   "class": "hub",
   "name": "Airport",
   "kind": "node",
   "role": "cites_hub",
   "entityId": "cl:node:7f440f59d02bad70",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "feed:lipid",
   "class": "feedstock",
   "name": "Lipid feedstock",
   "kind": "material",
   "role": "cites_feedstock",
   "entityId": "cl:material:aba0d2b214f2a369",
   "modes": [
    "air",
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "feed:uco",
   "class": "feedstock",
   "name": "Used cooking oil",
   "kind": "material",
   "role": "cites_feedstock",
   "entityId": "cl:material:9796702590ae69b1",
   "modes": [
    "air",
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "feed:tallow",
   "class": "feedstock",
   "name": "Tallow",
   "kind": "material",
   "role": "cites_feedstock",
   "entityId": "cl:material:8fffe0f4c2aa6116",
   "modes": [
    "air",
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "feed:lignocellulosic",
   "class": "feedstock",
   "name": "Lignocellulosic biomass",
   "kind": "material",
   "role": "cites_feedstock",
   "entityId": "cl:material:c64972963cb3fcd4",
   "modes": [
    "air",
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "feed:residues",
   "class": "feedstock",
   "name": "Waste and residue feedstock",
   "kind": "material",
   "role": "cites_feedstock",
   "entityId": "cl:material:574d0c61bd7fd91e",
   "modes": [
    "air",
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "carrier:hvo",
   "class": "carrier",
   "name": "Hydrotreated vegetable oil",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:a9277c8a190facec",
   "modes": [
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "carrier:hefa_saf",
   "class": "carrier",
   "name": "HEFA-SAF",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:36f86f3cc4407e6d",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "carrier:efuels",
   "class": "carrier",
   "name": "E-fuels",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:a7de1ca4d206c116",
   "modes": [
    "air",
    "ocean",
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:lng",
   "class": "carrier",
   "name": "Liquefied natural gas",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:c8be4653bfad0c74",
   "modes": [
    "ocean",
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:bio_lng",
   "class": "carrier",
   "name": "Bio-LNG",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:ab4a85c6c0c6fd32",
   "modes": [
    "ocean",
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:bio_methanol",
   "class": "carrier",
   "name": "Bio-methanol",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:b409fbb9b2fe3eee",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "carrier:green_ammonia",
   "class": "carrier",
   "name": "Green ammonia",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:7bb5045f00dddffa",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "carrier:renewable_electricity",
   "class": "carrier",
   "name": "Renewable electricity",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:30c70bed12414928",
   "modes": [
    "road",
    "ocean",
    "rail"
   ],
   "unit": null
  },
  {
   "key": "carrier:bio_bunkers",
   "class": "carrier",
   "name": "Bio-bunkers",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:6f1ceccf2f5fe812",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "node:shore_power",
   "class": "node",
   "name": "Shore power",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:4aa80df87d7188f6",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "node:hdv_charging",
   "class": "node",
   "name": "HDV charging",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:24b83f7af01a9a05",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "node:reefer_plugs",
   "class": "node",
   "name": "Reefer plugs",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:e880b21d1acbb4f9",
   "modes": [
    "ocean",
    "road"
   ],
   "unit": null
  },
  {
   "key": "node:grid_queues",
   "class": "node",
   "name": "Grid connection queues",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:9ddd95bcf6855e4b",
   "modes": [
    "road",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "node:bunkering",
   "class": "node",
   "name": "Bunkering",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:45cf3c0145bb7adf",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "node:saf_blending",
   "class": "node",
   "name": "SAF blending",
   "kind": "node",
   "role": "cites_node",
   "entityId": "cl:node:6777c671111b4d81",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "corridor:ocean_to_sea_air",
   "class": "corridor",
   "name": "Ocean to sea-air shift",
   "kind": "asset",
   "role": "cites_corridor",
   "entityId": "cl:asset:e7853e0a5af85678",
   "modes": [
    "ocean",
    "air"
   ],
   "unit": null
  },
  {
   "key": "corridor:sea_air_to_air",
   "class": "corridor",
   "name": "Sea-air to air shift",
   "kind": "asset",
   "role": "cites_corridor",
   "entityId": "cl:asset:7ca3ebd43d833613",
   "modes": [
    "ocean",
    "air"
   ],
   "unit": null
  },
  {
   "key": "corridor:rail_road",
   "class": "corridor",
   "name": "Rail and road shift",
   "kind": "asset",
   "role": "cites_corridor",
   "entityId": "cl:asset:fec701586a10c507",
   "modes": [
    "rail",
    "road"
   ],
   "unit": null
  },
  {
   "key": "corridor:inland_waterway",
   "class": "corridor",
   "name": "Inland waterway shift",
   "kind": "asset",
   "role": "cites_corridor",
   "entityId": "cl:asset:fa5cc310536dc62d",
   "modes": [
    "inland_waterway",
    "road"
   ],
   "unit": null
  },
  {
   "key": "instrument:32023R2405",
   "class": "instrument",
   "name": "32023R2405",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:1e073ab18e92de25",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "instrument:32023R1805",
   "class": "instrument",
   "name": "32023R1805",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:02eb79daf48ec2ca",
   "modes": [
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "instrument:32023R1804",
   "class": "instrument",
   "name": "32023R1804",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:4071cf5d182e141b",
   "modes": [
    "road",
    "ocean",
    "inland_waterway",
    "air"
   ],
   "unit": null
  },
  {
   "key": "instrument:32023L2413",
   "class": "instrument",
   "name": "32023L2413",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:8d00532ee05cc710",
   "modes": [
    "air",
    "ocean",
    "road",
    "rail",
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "instrument:32018L2001",
   "class": "instrument",
   "name": "32018L2001",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:ccc8f633a5dd1823",
   "modes": [
    "air",
    "ocean",
    "road",
    "rail",
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "instrument:32025R0040",
   "class": "mandate",
   "name": "32025R0040",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:a59c19e08e8938a8",
   "modes": [
    "air",
    "ocean",
    "road",
    "rail",
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "instrument:32023R0956",
   "class": "mandate",
   "name": "32023R0956",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:52ac5c4553c73cbf",
   "modes": [
    "air",
    "ocean",
    "road",
    "rail",
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "instrument:ISO14083",
   "class": "mandate",
   "name": "ISO 14083",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:a7a6acbd2f2e61e9",
   "modes": [
    "air",
    "ocean",
    "road",
    "rail",
    "inland_waterway"
   ],
   "unit": null
  },
  {
   "key": "attr:void_space_ratio",
   "class": "attribute",
   "name": "void_space_ratio",
   "kind": "method",
   "role": "cites_attribute",
   "entityId": "cl:method:f8e110f5659ca727",
   "modes": [],
   "unit": "%"
  },
  {
   "key": "attr:recycled_content",
   "class": "attribute",
   "name": "recycled_content",
   "kind": "method",
   "role": "cites_attribute",
   "entityId": "cl:method:90820c60a35a0970",
   "modes": [],
   "unit": "%"
  },
  {
   "key": "attr:ghg_intensity",
   "class": "attribute",
   "name": "ghg_intensity",
   "kind": "method",
   "role": "cites_attribute",
   "entityId": "cl:method:bcd01a61afdbec3f",
   "modes": [],
   "unit": "gCO2e/MJ"
  },
  {
   "key": "attr:abatement_cost_per_tco2e",
   "class": "attribute",
   "name": "abatement_cost_per_tco2e",
   "kind": "method",
   "role": "cites_attribute",
   "entityId": "cl:method:c96af1f546b98a0b",
   "modes": [],
   "unit": "EUR/tCO2e"
  },
  {
   "key": "attr:tonnage_cutoff",
   "class": "attribute",
   "name": "tonnage_cutoff",
   "kind": "method",
   "role": "cites_attribute",
   "entityId": "cl:method:05dababb8b1145cf",
   "modes": [],
   "unit": "GT"
  },
  {
   "key": "window:0-6m",
   "class": "window",
   "name": "0-6m",
   "kind": "method",
   "role": "cites_window",
   "entityId": "cl:method:9c6e5ad5973f81ba",
   "modes": [],
   "unit": null
  },
  {
   "key": "window:6-18m",
   "class": "window",
   "name": "6-18m",
   "kind": "method",
   "role": "cites_window",
   "entityId": "cl:method:2383b485cff5b01c",
   "modes": [],
   "unit": null
  },
  {
   "key": "window:18-36m",
   "class": "window",
   "name": "18-36m",
   "kind": "method",
   "role": "cites_window",
   "entityId": "cl:method:de617189c3d54540",
   "modes": [],
   "unit": null
  },
  {
   "key": "instrument:32003L0087",
   "class": "instrument",
   "name": "32003L0087",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:e89c7cee1cc94843",
   "modes": [
    "air",
    "ocean"
   ],
   "unit": null
  },
  {
   "key": "instrument:32019R1242",
   "class": "instrument",
   "name": "32019R1242",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:2fc66ca3274f714c",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "instrument:32024R1610",
   "class": "instrument",
   "name": "32024R1610",
   "kind": "instrument",
   "role": "cites_instrument",
   "entityId": "cl:instrument:06866e0bec81e01f",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:fossil_diesel",
   "class": "carrier",
   "name": "Fossil diesel and gas oil",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:90282e802850487f",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:fossil_gasoline",
   "class": "carrier",
   "name": "Fossil motor gasoline",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:856d87030723168a",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:fossil_jet",
   "class": "carrier",
   "name": "Fossil kerosene-type jet fuel",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:14ef706668db7883",
   "modes": [
    "air"
   ],
   "unit": null
  },
  {
   "key": "carrier:fossil_lpg",
   "class": "carrier",
   "name": "Fossil liquefied petroleum gas",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:cf08caa76aaa7f17",
   "modes": [
    "road"
   ],
   "unit": null
  },
  {
   "key": "carrier:fossil_fuel_oil",
   "class": "carrier",
   "name": "Fossil residual fuel oil",
   "kind": "material",
   "role": "cites_carrier",
   "entityId": "cl:material:4e3d861cf449961f",
   "modes": [
    "ocean"
   ],
   "unit": null
  }
 ],
 "relations": [
  {
   "parent": "feed:lipid",
   "child": "carrier:hefa_saf",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:lipid",
   "child": "carrier:hvo",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:tallow",
   "child": "carrier:hvo",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:tallow",
   "child": "carrier:hefa_saf",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:uco",
   "child": "carrier:hvo",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:uco",
   "child": "carrier:hefa_saf",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:lignocellulosic",
   "child": "carrier:bio_methanol",
   "relation": "feedstock_of"
  },
  {
   "parent": "feed:residues",
   "child": "carrier:hefa_saf",
   "relation": "feedstock_of"
  },
  {
   "parent": "carrier:hefa_saf",
   "child": "carrier:hvo",
   "relation": "competes_for_feedstock"
  },
  {
   "parent": "carrier:bio_bunkers",
   "child": "carrier:hefa_saf",
   "relation": "competes_for_feedstock"
  },
  {
   "parent": "carrier:bio_bunkers",
   "child": "carrier:hvo",
   "relation": "competes_for_feedstock"
  },
  {
   "parent": "carrier:hefa_saf",
   "child": "mode:air",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:efuels",
   "child": "mode:air",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:bio_bunkers",
   "child": "mode:ocean",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:hvo",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:bio_lng",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:renewable_electricity",
   "child": "mode:ocean",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:renewable_electricity",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "node:hdv_charging",
   "child": "node:shore_power",
   "relation": "shares_grid_zone"
  },
  {
   "parent": "node:grid_queues",
   "child": "node:hdv_charging",
   "relation": "shares_grid_zone"
  },
  {
   "parent": "node:grid_queues",
   "child": "node:shore_power",
   "relation": "shares_grid_zone"
  },
  {
   "parent": "node:bunkering",
   "child": "hub:seaport",
   "relation": "serves_hub"
  },
  {
   "parent": "node:shore_power",
   "child": "hub:seaport",
   "relation": "serves_hub"
  },
  {
   "parent": "node:saf_blending",
   "child": "hub:airport",
   "relation": "serves_hub"
  },
  {
   "parent": "corridor:ocean_to_sea_air",
   "child": "mode:ocean",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:ocean_to_sea_air",
   "child": "mode:air",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:sea_air_to_air",
   "child": "mode:air",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:sea_air_to_air",
   "child": "mode:ocean",
   "relation": "corridor_links"
  },
  {
   "parent": "carrier:lng",
   "child": "mode:ocean",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:green_ammonia",
   "child": "mode:ocean",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "node:reefer_plugs",
   "child": "hub:seaport",
   "relation": "serves_hub"
  },
  {
   "parent": "corridor:rail_road",
   "child": "mode:rail",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:inland_waterway",
   "child": "mode:inland_waterway",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:inland_waterway",
   "child": "mode:road",
   "relation": "corridor_links"
  },
  {
   "parent": "corridor:rail_road",
   "child": "mode:road",
   "relation": "corridor_links"
  },
  {
   "parent": "instrument:32023R2405",
   "child": "carrier:hefa_saf",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023R2405",
   "child": "node:saf_blending",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023R1805",
   "child": "carrier:bio_bunkers",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023R1805",
   "child": "node:shore_power",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023R1804",
   "child": "node:shore_power",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023R1804",
   "child": "node:hdv_charging",
   "relation": "implements"
  },
  {
   "parent": "instrument:32023L2413",
   "child": "instrument:32018L2001",
   "relation": "amends"
  },
  {
   "parent": "instrument:32025R0040",
   "child": "mode:air",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32023R0956",
   "child": "mode:air",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:ISO14083",
   "child": "mode:air",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32025R0040",
   "child": "mode:ocean",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32023R0956",
   "child": "mode:ocean",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:ISO14083",
   "child": "mode:ocean",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32025R0040",
   "child": "mode:road",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32023R0956",
   "child": "mode:road",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:ISO14083",
   "child": "mode:road",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32025R0040",
   "child": "mode:rail",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32023R0956",
   "child": "mode:rail",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:ISO14083",
   "child": "mode:rail",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32025R0040",
   "child": "mode:inland_waterway",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32023R0956",
   "child": "mode:inland_waterway",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:ISO14083",
   "child": "mode:inland_waterway",
   "relation": "consignment_wide"
  },
  {
   "parent": "instrument:32019R1242",
   "child": "node:hdv_charging",
   "relation": "implements"
  },
  {
   "parent": "instrument:32024R1610",
   "child": "node:hdv_charging",
   "relation": "implements"
  },
  {
   "parent": "instrument:32024R1610",
   "child": "instrument:32019R1242",
   "relation": "amends"
  },
  {
   "parent": "carrier:fossil_diesel",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:fossil_gasoline",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:fossil_jet",
   "child": "mode:air",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:fossil_lpg",
   "child": "mode:road",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "carrier:fossil_fuel_oil",
   "child": "mode:ocean",
   "relation": "fuel_for_mode"
  },
  {
   "parent": "instrument:32003L0087",
   "child": "attr:abatement_cost_per_tco2e",
   "relation": "implements"
  }
 ]
} as const;
