/// <reference lib="webworker" />
// Fits the vote model (model.fitBasis) off the main thread: it takes most of a second per map.
import { fitBasis } from './model';
import type { CellData, LocalData, Region } from './types';

export interface FitRequest {
	key: string;
	/** regions without geometry (it is not needed and is large to copy) */
	regions: Omit<Region, 'feature'>[];
	cells?: CellData;
	local?: LocalData;
}

self.onmessage = (e: MessageEvent<FitRequest>) => {
	const { key, regions, cells, local } = e.data;
	try {
		const basis = fitBasis(regions as Region[], cells, local);
		self.postMessage({ key, basis });
	} catch (err) {
		self.postMessage({ key, error: (err as Error).message });
	}
};
