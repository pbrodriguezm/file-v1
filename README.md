# Disco web

Disco de archivos sobre GitHub Pages, con usuario y clave. Permite navegar carpetas y subir, descargar y eliminar archivos. Todo se guarda cifrado en la rama `data` de este repositorio.

## Cómo protege los archivos

GitHub Pages no ejecuta código en el servidor y este repositorio es público, así que el acceso no depende de ocultar la pantalla. Depende del cifrado:

- Los archivos y sus nombres se cifran en el navegador con AES-256-GCM antes de subirse.
- La clave de cada usuario se transforma con PBKDF2-SHA256 (600 000 iteraciones) y abre una clave maestra guardada en `users.json`. Esa clave maestra descifra los archivos y el token de GitHub.
- La clave de usuario nunca se envía a ningún lado. El token y la clave maestra solo existen en memoria durante la sesión.

Límites que debes conocer:

- `users.json` es público, por lo que alguien puede intentar adivinar una clave sin conexión. Usa claves largas y únicas.
- Si se pierden todas las claves, los archivos no se pueden recuperar.
- Los archivos eliminados desaparecen del disco, pero siguen cifrados en el historial de Git.
- Cambiar una clave no revoca a quien ya conocía la anterior y conserve una copia antigua de `users.json`. Para revocar a alguien hay que crear un disco nuevo y rotar el token.

Cada archivo admite hasta 40 MB. GitHub recomienda no pasar de 1 GB por repositorio.

## Puesta en marcha

1. Crea un [token fine-grained](https://github.com/settings/personal-access-tokens/new) con acceso solo a `file-v1` y el permiso **Contents: Read and write**.
2. Ejecuta `node tools/admin.mjs add-user` (requiere Node 20 o superior). Te pedirá el token, tu usuario y tu clave.
3. Publica el resultado: `git add users.json && git commit -m "Configura usuarios" && git push`.
4. En **Settings → Pages**, elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`.

La web quedará en <https://pbrodriguezm.github.io/file-v1/>.

## Administración

- Agregar un usuario o cambiar una clave: `node tools/admin.mjs add-user`.
- Reemplazar un token vencido: `node tools/admin.mjs set-token`.

Después de cada cambio, publica `users.json` con `git push`.
