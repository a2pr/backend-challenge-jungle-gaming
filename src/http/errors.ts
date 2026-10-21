// A request the client must fix: bad body, missing header, bad cursor. `details` carries the zod issues.
export class BadRequestError extends Error {
    constructor(message: string, public readonly details?: unknown) {
        super(message);
        this.name = "BadRequestError";
        Object.setPrototypeOf(this, BadRequestError.prototype);
    }
}
