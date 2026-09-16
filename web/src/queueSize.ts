/** How many players a queue holds before it pops.
 *
 *  Its own module because two components now need it (routes/Play.tsx and
 *  components/QueueBar.tsx), and a second literal 8 sitting in one of them is
 *  the kind of drift that shows up as the bar reading "5/8" next to a panel
 *  reading "5/6" and nobody being able to say which is lying.
 *
 *  Still a duplicate of QUEUE_SIZE in src/queue.ts, which is the authority:
 *  the value is never sent to the client, so this mirrors it by hand. Changing
 *  the queue size means changing both. */
export const QUEUE_SIZE = 8;
