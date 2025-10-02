import React, { useContext } from "react";

import cockpit from 'cockpit';

import { debounce } from 'throttle-debounce';
import * as dfnlocales from 'date-fns/locale';
import { formatRelative } from 'date-fns';
const _ = cockpit.gettext;

export const DockerInfoContext = React.createContext();
export const useDockerInfo = () => useContext(DockerInfoContext);

export const WithDockerInfo = ({ value, children }) => {
    return (
        <DockerInfoContext.Provider value={value}>
            {children}
        </DockerInfoContext.Provider>
    );
};

// https://github.com/containers/podman/blob/main/libpod/define/containerstate.go
// "Restarting" comes from special handling of restart case in Application.updateContainer()
export const states = [_("Exited"), _("Paused"), _("Stopped"), _("Removing"), _("Configured"), _("Created"), _("Restart"), _("Running")];

export const fallbackRegistries = ["ghcr.io"];

export function debug(...args) {
    if (window.debugging === "all" || window.debugging?.includes("docker"))
        console.debug("docker", ...args);
}

export function truncate_id(id) {
    if (!id) {
        return "";
    }

    if (id.indexOf(":") !== -1)
        id = id.split(":")[1];

    return id.substr(0, 12);
}

export function localize_time(unix_timestamp) {
    if (unix_timestamp === undefined || isNaN(unix_timestamp))
        return "";
    const locale = (cockpit.language == "en") ? dfnlocales.enUS : dfnlocales[cockpit.language.replace('_', '')];
    return formatRelative(unix_timestamp * 1000, Date.now(), { locale });
}

export function format_cpu_usage(stats) {
    const cpu_usage = stats?.cpu_stats?.cpu_usage?.total_usage;
    const system_cpu_usage = stats?.cpu_stats?.system_cpu_usage;
    const precpu_usage = stats?.precpu_stats?.cpu_usage?.total_usage;
    const precpu_system_cpu_usage = stats?.precpu_stats?.system_cpu_usage;

    if (cpu_usage === undefined || isNaN(cpu_usage))
        return "";

    let cpu_percent = 0;
    if (precpu_usage !== undefined && precpu_system_cpu_usage !== undefined) {
        const cpu_delta = cpu_usage - precpu_usage;
        const system_delta = system_cpu_usage - precpu_system_cpu_usage;
        if (system_delta > 0 && cpu_delta > 0)
            cpu_percent = (cpu_delta / system_delta) * stats.cpu_stats.online_cpus * 100;
    }

    return [cpu_percent.toFixed(2) + "%", cpu_percent];
}

export function format_memory_and_limit(stats) {
    const usage = stats?.memory_stats?.usage;
    const limit = stats?.memory_stats?.limit;

    if (usage === undefined || isNaN(usage))
        return "";

    let mtext = "";
    let unit;
    let parts;
    if (limit) {
        parts = cockpit.format_bytes(limit, undefined, { separate: true });
        mtext = " / " + parts.join(" ");
        unit = parts[1];
    }

    if (usage) {
        parts = cockpit.format_bytes(usage, unit, { separate: true });
        if (mtext)
            return [_(parts[0] + mtext), usage];
        else
            return [_(parts.join(" ")), usage];
    } else {
        return ["", -1];
    }
}

/*
 * The functions quote_cmdline and unquote_cmdline implement
 * a simple shell-like quoting syntax.  They are used when letting the
 * user edit a sequence of words as a single string.
 *
 * When parsing, words are separated by whitespace.  Single and double
 * quotes can be used to protect a sequence of characters that
 * contains whitespace or the other quote character.  A backslash can
 * be used to protect any character.  Quotes can appear in the middle
 * of a word.
 */

export function quote_cmdline(words) {
    words = words || [];

    if (typeof words === 'string')
        words = words.split(' ');

    function is_whitespace(c) {
        return c == ' ';
    }

    function quote(word) {
        let text = "";
        let quote_char = "";
        let i;
        for (i = 0; i < word.length; i++) {
            if (word[i] == '\\' || word[i] == quote_char)
                text += '\\';
            else if (quote_char === "") {
                if (word[i] == "'" || is_whitespace(word[i]))
                    quote_char = '"';
                else if (word[i] == '"')
                    quote_char = "'";
            }
            text += word[i];
        }

        return quote_char + text + quote_char;
    }

    return words.map(quote).join(' ');
}

export function unquote_cmdline(text) {
    const words = [];
    let next;

    function is_whitespace(c) {
        return c == ' ';
    }

    function skip_whitespace() {
        while (next < text.length && is_whitespace(text[next]))
            next++;
    }

    function parse_word() {
        let word = "";
        let quote_char = null;

        while (next < text.length) {
            if (text[next] == '\\') {
                next++;
                if (next < text.length) {
                    word += text[next];
                }
            } else if (text[next] == quote_char) {
                quote_char = null;
            } else if (quote_char) {
                word += text[next];
            } else if (text[next] == '"' || text[next] == "'") {
                quote_char = text[next];
            } else if (is_whitespace(text[next])) {
                break;
            } else
                word += text[next];
            next++;
        }
        return word;
    }

    next = 0;
    skip_whitespace();
    while (next < text.length) {
        words.push(parse_word());
        skip_whitespace();
    }

    return words;
}

export function image_name(image) {
    return image.RepoTags.length > 0 ? image.RepoTags[0] : "<none>:<none>";
}

export function is_valid_container_name(name) {
    return /^[a-zA-Z0-9][a-zA-Z0-9_\\.-]*$/.test(name);
}

/* Clears a single field in validationFailed object.
 *
 * Arguments:
 *   - validationFailed (object): Object containing list of fields with validation error
 *   - key (string): Specified which field from validationFailed object is clear
 *   - onValidationChange (func)
 */
export const validationClear = (validationFailed, key, onValidationChange) => {
    if (!validationFailed)
        return;

    const delta = { ...validationFailed };
    delete delta[key];
    onValidationChange(delta);
};

// This method needs to be outside of component as re-render would create a new instance of debounce
export const validationDebounce = debounce(500, (validationHandler) => validationHandler());
