import * as Comlink from "comlink";
import type { IfcFacade } from "#modules/ifc/facade";
import { emitLog, type LogEntry } from "#lib/log";
import IfcWorker from "./worker/ifc-worker?worker";
import type { IfcWorkerApi } from "./worker/ifc-worker";

/**
 * Lazy-instantiated IfcFacade backed by a web-ifc Web Worker.
 * The facade manages the active modelID internally, callers never
 * see it. Swap the implementation here to switch IFC backends.
 */

let instance: { facade: IfcFacade; worker: Worker } | null = null;

export function getIfc(): IfcFacade {
  if (instance) {
    return instance.facade;
  }

  const worker = new IfcWorker();
  const api = Comlink.wrap<IfcWorkerApi>(worker);

  // Forward worker-side log entries into the main-thread log store.
  void api.setLogSink(
    Comlink.proxy((entry: LogEntry) => {
      emitLog({
        level: entry.level,
        source: "worker",
        message: entry.message,
      });
    }),
  );

  let modelID: number | null = null;

  function requireModel(): number {
    if (modelID === null) {
      throw new Error("No IFC model is open");
    }
    return modelID;
  }

  const facade: IfcFacade = {
    async open(file, onProgress) {
      if (modelID !== null) {
        await api.closeModel(modelID).catch((error: unknown) => {
          emitLog({
            level: "warn",
            message: `Failed to close previous model: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
        modelID = null;
      }
      const proxy = onProgress ? Comlink.proxy(onProgress) : undefined;
      // File is structured-cloneable, so Comlink transfers it to the
      // worker without copying the bytes into JS heap on either side.
      modelID = await api.openModel(file, proxy);
    },
    async readMetadata() {
      return api.readMetadata(requireModel());
    },
    async extractFootprint() {
      return api.extractFootprint(requireModel());
    },
    async extractMeshes() {
      return api.extractMeshes(requireModel());
    },
    async extractSpaces() {
      return api.extractSpaces(requireModel());
    },
    async writeMapConversion(
      epsgCode,
      verticalDatum,
      parameters,
      siteReference,
      crsMetresPerUnit,
    ) {
      await api.writeMapConversion(
        requireModel(),
        epsgCode,
        verticalDatum,
        parameters,
        siteReference,
        crsMetresPerUnit,
      );
    },
    async zeroSitePlacementLocation() {
      await api.zeroSitePlacementLocation(requireModel());
    },
    async save() {
      return api.saveModel(requireModel());
    },
    async close() {
      const id = modelID;
      modelID = null;
      if (id !== null) {
        await api.closeModel(id);
      }
    },
  };

  instance = { facade, worker };
  return facade;
}
