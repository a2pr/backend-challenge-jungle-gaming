import {CanActivate, Injectable} from "@nestjs/common";

// Auth is out of scope (README §2, 0 points). This is the extension point: controllers use @UseGuards(AuthGuard),
// and a real one (JWT / OIDC) replaces this class, or is registered with { provide: AuthGuard, useClass: ... }.
// Health and metrics never use it.
@Injectable()
export class AuthGuard implements CanActivate {
    canActivate(): boolean {
        return true;
    }
}
