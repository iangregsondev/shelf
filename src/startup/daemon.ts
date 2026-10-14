#!/usr/bin/env bun
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runMain } from "@effect/platform-bun/BunRuntime";
import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { daemonProgram } from "../domain/daemon/daemon-service";
import { DaemonAppLayer } from "./layers/daemon";

daemonProgram.pipe(
	Effect.provide(DaemonAppLayer.pipe(Layer.provideMerge(BunServicesLayer))),
	runMain,
);
