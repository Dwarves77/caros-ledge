import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyItemBindingPosition } from "@/features/obligations/derive/classify-binding-position";
import { commonActionCardProps } from "@/ui/detail/action-card-props";
import type { Resource } from "@/core/types";

test("classifyItemBindingPosition: attributes common statutory duty holders without falling through to null", () => {
  const item = { title: "Generic Technical Standard" };

  // monitoring_only (ecosystem context / non-binding on forwarder): duties on supply-chain actors that exclude forwarder
  for (const role of [
    "carrier", "operator", "shipper", "producer",
    "importer_of_record", "exporter", "distributor", "packer_filler", "rating_provider", "undertaking",
  ]) {
    const res = classifyItemBindingPosition(item, { dutyHolderClasses: [role] });
    assert.equal(res?.position, "monitoring_only", `${role} should classify to monitoring_only`);
    assert.equal(res?.source, "duty_holder_excludes_forwarder");
  }
});

test("commonActionCardProps: derives whoPays and yourLanes from resource attributes", () => {
  const dummyNode = null as never;
  const resWithLanes: Resource = {
    id: "r1",
    title: "Test Resource",
    jurisdiction: "EU",
    modes: ["ocean", "road"],
    costMechanism: "Bunker fuel levy",
  } as Resource;

  const props1 = commonActionCardProps(resWithLanes, { tagPopover: dummyNode, watch: dummyNode, onTag: () => {} });
  assert.equal(props1.whoPays.value, "Bunker fuel levy");
  assert.equal(props1.yourLanes.value, "EU · Ocean, Road");

  const resFallback: Resource = {
    id: "r2",
    title: "Test Resource 2",
    whoIsBound: ["ocean carriers", "fuel suppliers"],
    jurisdiction: null,
    modes: [],
  } as unknown as Resource;

  const props2 = commonActionCardProps(resFallback, { tagPopover: dummyNode, watch: dummyNode, onTag: () => {} });
  assert.equal(props2.whoPays.value, "Obligated: ocean carriers, fuel suppliers");
  assert.equal(props2.yourLanes.value, null);
  assert.equal(props2.yourLanes.absenceReason, "connect data");
});
