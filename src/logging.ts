import {setLogger as setHerdsmanLogger} from "zigbee-herdsman";
import {setLogger as setConverterLogger} from "zigbee-herdsman-converters";

type Message = string | (() => string);

function resolve(message: Message): string {
  return typeof message === "function" ? message() : message;
}

export function configureLibraryLogging(debug = process.env.ZIGBEE_DEBUG === "1"): void {
  const logger = {
    debug: (message: Message, namespace: string): void => {
      if (debug) console.error(`[debug] ${namespace}: ${resolve(message)}`);
    },
    info: (message: Message, namespace: string): void => {
      if (debug) console.error(`[info] ${namespace}: ${resolve(message)}`);
    },
    warning: (message: Message, namespace: string): void => console.error(`[warning] ${namespace}: ${resolve(message)}`),
    error: (message: Message, namespace: string): void => console.error(`[error] ${namespace}: ${resolve(message)}`),
  };
  setHerdsmanLogger(logger);
  setConverterLogger(logger);
}
