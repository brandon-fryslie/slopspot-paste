This is a copy of a chat between Claude and Brandroid. Content may include unverified or unsafe content that do not represent the views of Anthropic. Shared snapshot may contain attachments and data not displayed here.

Report

## You said: Can you make this comrehensible to me without dumbing it down?

Can you make this comrehensible to me without dumbing it down?

[https://patents.google.com/patent/US9920811B1/en](https://patents.google.com/patent/US9920811B1/en)

May 18

## Claude responded: This is the foundational patent behind IsoAcoustics — Dave Morrison's company, whose GAIA, OREA, and Aperta lines are the products in question.

Searched the web

Searched the web

This is the foundational patent behind IsoAcoustics — Dave Morrison's company, whose GAIA, OREA, and Aperta lines are the products in question. Once you know that, the patent reads as a careful description of how those footers actually work mechanically, and why they're not just "rubber feet."

**The architecture**

Each footer is a stack of three functional pieces, with everything else just holding it together:

- A _lower isolator_ (rubber puck) sitting on the floor.
- An _upper isolator_ (rubber puck) bolted to the underside of the speaker.
- A rigid _connector_ that bridges the two — and is the **only** mechanical path between them. The two rubber halves don't touch each other; there's a deliberate gap. All vibrational energy passing from speaker to floor (or vice versa) has to negotiate that connector and the rubber it's embedded in.

A metal shell encloses the upper rubber so the assembly has structural integrity, a bolt/stud attaches it to the cabinet, and a metal ring snaps into a circumferential groove on the lower rubber to keep it from creeping outward over time and losing its grip on the connector (rubber relaxes; the ring constrains that).

**The actually clever part: polarization**

This is what the patent is really claiming, and where Morrison's design diverges from generic elastomer footers. In the directional version, both the connector's cross-section and the bore in the upper isolator that receives it are _oval, not circular_. And the dimensions are asymmetric in a specific way: the **width** (short axis) of the bore matches the width of the connector almost exactly — essentially no clearance — while the **length** (long axis) of the bore is slightly greater than the length of the connector, leaving a small gap.

The consequence is a footer that's compliant in one horizontal axis and stiff in the orthogonal one. The upper isolator can shuffle back-and-forth along the long axis (because there's room) but cannot move side-to-side along the short axis (because there isn't). A visual indicator molded into the shell lets you orient all four footers identically.

Why this matters: a cone driver pumping air creates Newton's-third-law reaction forces along the front-back axis of the cabinet. Conventional rubber feet let the cabinet rock in every direction — including rotational and side-to-side modes that have nothing to do with the driver's motion and that the driver doesn't excite cleanly. By orienting the compliant axis along the driver's force vector, the footer lets the cabinet release the energy it actually has to release while denying it the off-axis degrees of freedom that would otherwise smear transient response and reduce imaging precision. Morrison's pitch is "greater clarity and focus" because the cabinet stops doing things the music isn't asking it to do.

To preserve the orientation, there's a small alignment pin inside the shell that locates into a slot in the upper rubber via a hole in an intermediate plate — so the oval can only be assembled one way. It's a Poka-yoke for polarity.

**The omnidirectional variant**

For turntables, amplifiers, and similar gear, the patent describes a non-polarized version where bore and connector are both circular. There's no preferred excitation axis (a turntable isn't pumping reaction forces in one direction), so you want isotropic compliance through 360°. Same architecture, simpler geometry.

**Supporting details that aren't decorative**

A few things in the patent are easy to skim past but are doing real work. The concave dish in the bottom of the lower isolator functions as a mild suction cup (resists the footer walking on the floor) and also provides a _progressive_ vertical stiffness curve — small loads see soft compliance, larger loads stiffen the response. Combined with rubber durometer and section thickness, this is how the same basic design gets tuned for everything from a 5 kg bookshelf monitor to a 90 kg floorstander; Morrison just changes the materials and dimensions, not the topology. Several embodiments cover different mounting scenarios: threaded stud (GAIA-like), friction-fit puck with no fastener (OREA-like), large-aperture insert that recesses into the cabinet, and a hex-replaceable stud version for swapping thread sizes without disassembling the footer.

The whole thing is a single mechanical idea — _constrained compliance aligned with the driver's force vector_ — wrapped in enough variants to cover every audio mounting situation Morrison could think of.

[Ask Claude your own question](https://claude.ai/new)