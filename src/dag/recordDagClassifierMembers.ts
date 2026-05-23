/**
 * Names of the per-record classifier nodes that participate in the
 * `classify-all` parallel placement. Listed here (not inline in recordDag.ts)
 * so consumers can introspect / extend the membership.
 *
 * Adding a classifier: append its name here AND register the node with the
 * dispatcher AND list it in the run's `targetConfig.classifiers`. The conflict
 * resolver downstream consumes whatever wrote into `state.proposals`.
 */
export const classifyAllParallelMembers: ReadonlyArray<string> = [
  'classify:discriminator',
  'classify:source',
  'classify:url-pattern',
  'classify:structural',
  'classify:rules',
  'classify:schema',
  'classify:shacl-shape',
  'classify:property-fingerprint',
  'classify:winknlp-entities',
];

/**
 * Classifier nodes that run SEQUENTIALLY after the parallel placement because
 * they read other classifiers' proposals (race-unsafe in parallel).
 *
 * Order matters: ontology runs first (validate against class map), then
 * taxonomic-narrowing (drop supertype proposals).
 */
export const classifyPostParallelMembers: ReadonlyArray<string> = [
  'classify:ontology',
  'classify:taxonomic-narrowing',
];
