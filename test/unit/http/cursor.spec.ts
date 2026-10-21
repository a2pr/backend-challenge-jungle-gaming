import {describe, expect, it} from 'vitest';
import {decodeCursor, encodeCursor} from '../../../src/http/cursor.js';
import {BadRequestError} from '../../../src/http/errors.js';

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

describe('cursor', () => {
    it.each([0, 1, 50, 9007199254740991])('round trips seq %i', (seq) => {
        expect(decodeCursor(encodeCursor(seq))).toBe(seq);
    });

    it('is opaque: base64url text, not a readable number', () => {
        expect(encodeCursor(42)).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(encodeCursor(42)).not.toContain('42');
    });

    it.each([
        ['not base64url json', 'hello world'],
        ['empty', ''],
        ['json without seq', b64({page: 2})],
        ['negative seq', b64({seq: -1})],
        ['fractional seq', b64({seq: 1.5})],
        ['string seq', b64({seq: '5'})],
        ['null seq', b64({seq: null})],
        ['seq beyond 2^53', b64('{"seq":9007199254740993}')],
        ['json that is not an object', b64('5')],
        ['null json', b64('null')],
    ])('rejects %s with BadRequestError', (_name, cursor) => {
        expect(() => decodeCursor(cursor)).toThrow(BadRequestError);
    });
});
