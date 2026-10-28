# Review protocol (round 4)

The references in `references.csv` are **assistant-reviewed**, not human gold. They were made
this way, with no inference API calls:

1. `ml/review-packets.ts` turned every item into a blind packet: the system, the event as it
   arrived, the same service's previous lines (2 minutes, up to 20) and a sample of all services
   within 30 seconds (up to 30), with repeats collapsed. Packets don't show Jev's answer, the
   weak label, any score, or when the fault was injected. Identical messages of one service in
   the same minute of a case share a packet.
2. Each batch of about 60 packets went to two Claude subagents, A and B. They were started
   fresh, with no shared context, and each saw only its batch file and the instructions below.
3. A third subagent adjudicated only the packets where A and B disagreed. It saw both labels
   and rationales.
4. Every event of a packet takes the packet's final label. An important item (`must_reach`
   candidate, a miss positive, or a conflict) that ends `unsure` becomes `unknown`. It is left
   out of training and added to the must-reach checks, so that it is forwarded conservatively.

## Instructions given to reviewers A and B

> You are reviewing production log events for an on-call triage system. For each packet in
> `<batch file>`, decide whether a person or an agent on call should know about **this event**,
> as a problem or a symptom of one:
>
> - `relevant`: it reports or shows a failure, a degradation, data exposure (passwords, card
>   numbers or tokens in plain text) or a security problem, or it is a symptom of one visible in
>   the context.
> - `benign`: routine operation; dropping it is fine, even when other things in the context are
>   failing.
> - `unsure`: the packet doesn't let you tell.
>
> Judge the event itself and use the context only to interpret it. A routine success line is
> benign even during an incident, and an error is not benign just because it is frequent. Don't
> guess: an empty or uninformative body is `unsure`, unless the context makes it clear.
>
> Read only the batch file. Don't open any other file, and don't run commands except to write
> your output. Write one JSON object per line to `<output file>`:
> `{"packet": "p0001", "label": "relevant|benign|unsure", "confidence": 0.0-1.0, "rationale": "one or two sentences"}`.
> Write a line for every packet in the batch.

## Instructions given to the adjudicator

> For each packet listed in `<disagreements file>` (the packet text with reviewer A's and B's
> labels and rationales), decide the label with the same definitions. You may agree with
> either reviewer or choose `unsure`. Read only that file. Write
> `{"packet", "label", "confidence", "rationale"}` lines to `<output file>`.
