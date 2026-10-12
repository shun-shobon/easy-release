import * as v from "valibot";

export const nonempty = v.pipe(v.string(), v.minLength(1));
