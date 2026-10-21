import {Body, Controller, Get, Param, Post, UseGuards} from '@nestjs/common';
import {MikroORM} from "@mikro-orm/postgresql";
import {z} from "zod";
import {parse} from "../http/zodValidation.js";
import {createWalletSchema} from "../http/dto/createWallet.dto.js";
import {AuthGuard} from "../http/auth.guard.js";
import {CreateWalletUseCase} from "./createWallet.usecase.js";
import {WalletRepository} from "./wallet.repository.js";
import {WalletNotFoundError} from "../wager/errors.js";

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletController {
    constructor(
        private readonly orm: MikroORM,
        private readonly createWallet: CreateWalletUseCase,
        private readonly wallets: WalletRepository,
    ) {
    }

    // 201 is Nest's default for @Post; the use case result already has the README body.
    @Post()
    create(@Body() body: unknown) {
        return this.createWallet.execute(parse(createWalletSchema, body))
    }

    @Get(':id')
    async findOne(@Param('id') rawId: string) {
        const id = parse(z.uuid(), rawId)      // a non-UUID is a 400, not a Postgres error (503)
        const wallet = await this.wallets.findById(this.orm.em.fork(), id)
        if (!wallet) throw new WalletNotFoundError(id)
        return {id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version}
    }
}
