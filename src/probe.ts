import {Ezsp} from "zigbee-herdsman/dist/adapter/ember/ezsp/ezsp.js";
import {EZSP_MIN_PROTOCOL_VERSION, EZSP_PROTOCOL_VERSION, EZSP_STACK_TYPE_MESH} from "zigbee-herdsman/dist/adapter/ember/ezsp/consts.js";
import {EmberVersionType, EzspStatus, SLStatus} from "zigbee-herdsman/dist/adapter/ember/enums.js";
import {firmwareAtLeast} from "./device-utils.js";
import type {ProbeResult} from "./types.js";

export async function probePort(port: string): Promise<ProbeResult> {
  const ezsp = new Ezsp({path: port, adapter: "ember", baudRate: 115200, rtscts: false});
  let started = false;

  try {
    const status = await ezsp.start();
    if (status !== EzspStatus.SUCCESS) {
      throw new Error(`ASH handshake failed with ${EzspStatus[status] ?? status}`);
    }
    started = true;

    let [protocolVersion, stackType, stackVersion] = await ezsp.ezspVersion(EZSP_PROTOCOL_VERSION);
    const supportedByHost = protocolVersion >= EZSP_MIN_PROTOCOL_VERSION && protocolVersion <= EZSP_PROTOCOL_VERSION;
    if (!supportedByHost) {
      return {
        port,
        protocolVersion,
        stackType,
        stackVersion,
        firmware: "unknown",
        firmwareMeta: {},
        eui64: "unknown",
        meetsRecommendedFirmware: false,
        supportedByHost: false,
      };
    }

    if (protocolVersion !== EZSP_PROTOCOL_VERSION) {
      [protocolVersion, stackType, stackVersion] = await ezsp.ezspVersion(protocolVersion);
    }
    ezsp.setProtocolVersion(protocolVersion);

    if (stackType !== EZSP_STACK_TYPE_MESH) {
      throw new Error(`The adapter reports stack type ${stackType}; expected Ember mesh stack ${EZSP_STACK_TYPE_MESH}`);
    }

    const [versionStatus, version] = await ezsp.ezspGetVersionStruct();
    if (versionStatus !== SLStatus.OK) {
      throw new Error(`Unable to read structured firmware version: ${SLStatus[versionStatus] ?? versionStatus}`);
    }
    const eui64 = await ezsp.ezspGetEui64();
    const firmwareMeta: Record<string, number | string> = {
      ezsp: protocolVersion,
      major: version.major,
      minor: version.minor,
      patch: version.patch,
      type: EmberVersionType[version.type] ?? version.type,
      build: version.build,
      special: version.special,
    };

    return {
      port,
      protocolVersion,
      stackType,
      stackVersion,
      firmware: `${version.major}.${version.minor}.${version.patch} [${EmberVersionType[version.type] ?? version.type}]`,
      firmwareMeta,
      eui64,
      meetsRecommendedFirmware: firmwareAtLeast(firmwareMeta, [7, 4, 4]),
      supportedByHost: true,
    };
  } finally {
    if (started) await ezsp.stop();
  }
}
