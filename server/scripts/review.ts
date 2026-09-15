/** Build the review now and print it. */
import { buildReview } from '../src/review.js';

const r = await buildReview();
console.log(r.report);
