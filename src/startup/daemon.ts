#!/usr/bin/env node
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { daemonProgram } from "../domain/daemon/daemon-service";
import { DaemonAppLayer } from "./layers/daemon";

daemonProgram.pipe(
	Effect.provide(DaemonAppLayer.pipe(Layer.provideMerge(NodeServicesLayer))),
	runMain,
);
