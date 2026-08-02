import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-playground — the agent test bench: try prompts and skills against a
 * one-shot agent run (always fenced read-only), and preview which steps a
 * pipeline would execute — all without touching GitHub, the repo, or any state.
 * It owns no tables; every run it spawns is a normal operate one-shot, so the
 * transcript, queueing and token accounting come for free. Saved evaluation
 * cases and their bounded result history are this module's durable state.
 */
export default defineManifest({
  id: 'playground',
  title: 'Playground',
  version: '0.1.0',
  // operate = the execution plane (one-shots, skills, checkouts); workspace =
  // repo access scoping. module-code is a SOFT dep (tryGet) — the pipeline
  // preview needs it, prompt/skill testing does not.
  dependsOn: ['operate', 'workspace', 'core'],
  autoInstall: false,
  permissions: ['playground:run'],
  messages: ['playground.changed'],
  // Soft: the Agent Lab offers a repo picker only when code is enabled AND the
  // viewer may list repos; with code off the picker is simply absent.
  consumes: ['repos:read'],
});
