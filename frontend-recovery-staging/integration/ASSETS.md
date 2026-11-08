# Recovered asset status

The production publish folder `quiz oferta extraido` now contains the original
campaign image files recovered from the project backup, plus the four payment
logos retrieved from the old Netlify deployment. A regression test checks the
campaign image references and verifies the recovered files byte-for-byte.

Three customer review photos referenced by the storefront are still missing.
Their metadata and original URLs remain in the bundle, but the Lovable host
returns 404 and neither the repository, Git history, recovered deploy assets,
nor local backups contain their original bytes:

- `https://olympikusoutubrorosa.lovable.app/__l5e/assets-v1/1ce7a28e-6a5a-43e0-90eb-698ce7b533e8/2967ff8d-fc76-483d-a804-41be6e8d53b1/review-cliente-1.webp`
- `https://olympikusoutubrorosa.lovable.app/__l5e/assets-v1/1ce7a28e-6a5a-43e0-90eb-698ce7b533e8/31e4b9be-c550-409e-bc85-0a36364e9e38/review-cliente-2.webp`
- `https://olympikusoutubrorosa.lovable.app/__l5e/assets-v1/1ce7a28e-6a5a-43e0-90eb-698ce7b533e8/478fef7d-547a-4015-8fac-2e101f665c08/review-cliente-3.webp`

The review image IDs are preserved from the original bundle. Their original
bytes must be supplied from a source backup or another authorized copy. No
substitute images were created.
