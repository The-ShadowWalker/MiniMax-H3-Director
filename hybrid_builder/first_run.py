"""Optional, removable first-run Hybrid builder.

When prebuilt Hybrid checkpoints are distributed, this entire module can be
removed without changing the runtime Hybrid pipeline.
"""
import argparse
from .builder import HybridBuildSpec, build_with_cache

p = argparse.ArgumentParser()
p.add_argument("--fl2va", required=True)
p.add_argument("--ref2va", required=True)
p.add_argument("--output", default=None,
               help="Optional explicit output path. By default a descriptive filename is generated.")
p.add_argument("--start-block", type=int, default=30)
p.add_argument("--end-block", type=int, default=49)
p.add_argument("--include-final-adaln", action="store_true")
a = p.parse_args()

if not 0 <= a.start_block <= 49 or not 0 <= a.end_block <= 49 or a.start_block > a.end_block:
    raise SystemExit("Block range must be within 0..49 and start <= end.")

spec = HybridBuildSpec(
    base_checkpoint=a.fl2va,
    reference_checkpoint=a.ref2va,
    start_block=a.start_block,
    end_block=a.end_block,
    include_final_adaln=a.include_final_adaln,
)
print(build_with_cache(spec, a.output))
