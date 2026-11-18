import license from "../../../LICENSE" with { type: "text" };
import thirdParty from "../../../THIRD_PARTY_NOTICES.md" with { type: "text" };

/**
 * The licenses that must travel with the executables. They are compiled in, so
 * a collector installed through a server's install script carries them too.
 */
export const LICENSE_NOTICES = `${license.trim()}\n\n${thirdParty.trim()}\n`;
