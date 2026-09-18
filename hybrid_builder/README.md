# Optional BF16 Hybrid Builder

The builder uses WanGP's `shared.utils.files_locator` active checkpoint-path
system instead of assuming one `ckpts` directory or `base_checkpoint.parent`.

All active checkpoint roots are searched, recursively, for H3/Minimax
safetensors. This allows FL2VA and Ref2VA to live on different configured
drives. The generated Hybrid defaults to WanGP's primary checkpoint root.

The builder remains isolated and removable when prebuilt Hybrid downloads are
available.
