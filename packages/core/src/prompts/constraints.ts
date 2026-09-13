/**
 * The observation constraint.
 *
 * Appended to every prompt that describes what a person does. This is the
 * product's privacy guarantee expressed as prompt text, and it is the one
 * sentence in this package that every producing agent shares.
 *
 * Baton may state that no other volunteer has been *seen* doing something. It may
 * never state that no one else *can*. The distinction is the whole difference
 * between a coverage observation and a judgment about a person's competence, and
 * a coordinator reading the second would be right to stop trusting the tool.
 *
 * It lives in its own module rather than in the prompts barrel because the six
 * prompt bodies import it and the barrel re-exports them — defining it in the
 * barrel would make that a cycle.
 */

export const OBSERVATION_CONSTRAINT = [
  "You may only describe what has been observed in the messages you were given.",
  "Never state or imply that a person is unable to do something, only that nobody",
  "else has been seen doing it. Never compare volunteers. Never characterise a",
  "person's reliability, effort, or availability.",
].join(" ");
