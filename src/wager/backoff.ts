export function backoffMs(attempts: number, baseMs: number, capMs: number): number{
    if(attempts < 0 ){
        throw Error('attempts should be non negative values')
    }
    return Math.min(baseMs*2 ** attempts,capMs)
}