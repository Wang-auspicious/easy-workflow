export interface ResourceDemand { key: string; work: number; max: number; review?: boolean }

/** Spec §7.2: proportional floors, then spare slots in descending λ × s order. */
export function allocateResource(capacity: number, demands: ResourceDemand[], reserveReview = false) {
  const allocation = new Map(demands.map(demand => [demand.key, 0]));
  let left = Math.max(0, Math.floor(capacity));
  const ranked = [...demands].filter(demand => demand.max > 0 && Number.isFinite(demand.work) && demand.work >= 0)
    .sort((a, b) => b.work - a.work || a.key.localeCompare(b.key));
  const reviewer = reserveReview && ranked.find(demand => demand.review);
  if (left && reviewer) { allocation.set(reviewer.key, 1); left--; }
  while (left > 0) {
    const open = ranked.filter(demand => allocation.get(demand.key)! < demand.max);
    if (!open.length) break;
    const total = open.reduce((sum, demand) => sum + demand.work, 0), available = left;
    for (const demand of open) {
      const current = allocation.get(demand.key)!;
      const share = Math.min(demand.max - current, Math.floor(available * (total ? demand.work / total : 1 / open.length)));
      allocation.set(demand.key, current + share); left -= share;
    }
    for (const demand of open) {
      if (!left) break;
      const current = allocation.get(demand.key)!;
      if (current < demand.max) { allocation.set(demand.key, current + 1); left--; }
    }
  }
  return allocation;
}
