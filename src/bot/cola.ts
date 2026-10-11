/**
 * Cola simple: procesa un comprobante a la vez para no saturar Banxico ni NVIDIA.
 *
 * - Avisa a cada comprobante en espera cuando avanza su lugar en la fila.
 * - Cuenta cuántos comprobantes tiene cada persona (para limitarlos).
 * - Tiempo máximo por tarea: al vencer, la tarea se cancela (su `signal` se aborta) y la cola sigue
 *   con la siguiente. La tarea puede quitarse el límite cuando ya no debe cortarse a la mitad.
 */
export class TiempoAgotado extends Error {
  constructor(readonly limiteMs: number) {
    super(`La tarea superó el tiempo máximo de ${Math.round(limiteMs / 1000)} s`);
    this.name = "TiempoAgotado";
  }
}

export interface ControlTarea {
  /** Se aborta (con TiempoAgotado) si la tarea supera el tiempo máximo. */
  signal: AbortSignal;
  /** Desde ahora la tarea ya no tiene tiempo máximo. */
  quitarLimite: () => void;
}

export interface OpcionesTarea {
  /** Dueño de la tarea (para contar cuántas tiene cada persona). */
  usuario?: string;
  /** Tiempo máximo desde que la tarea empieza. */
  limiteMs?: number;
  /** Se llama cuando avanza la fila: cuántas tareas quedan antes que esta (la que está en curso incluida). */
  alCambiarPosicion?: (antes: number) => void;
}

export class Cola {
  private cadena: Promise<void> = Promise.resolve();
  /** Tareas en curso (la primera) y en espera, en orden. */
  private fila: OpcionesTarea[] = [];

  /** Tareas en curso o esperando. */
  get enEspera(): number {
    return this.fila.length;
  }

  /** Tareas en curso o esperando de una persona. */
  deUsuario(usuario: string): number {
    return this.fila.filter((t) => t.usuario === usuario).length;
  }

  /** Agrega una tarea al final. Sus errores no detienen la cola. */
  agregar<T>(tarea: (control: ControlTarea) => Promise<T>, opciones: OpcionesTarea = {}): Promise<T> {
    const entrada = { ...opciones };
    this.fila.push(entrada);
    const resultado = this.cadena.then(() => ejecutarConLimite(tarea, opciones.limiteMs)).finally(() => {
      this.fila.splice(this.fila.indexOf(entrada), 1);
      // La primera ya está empezando; a las demás se les avisa su nuevo lugar.
      this.fila.forEach((t, i) => {
        if (i > 0) t.alCambiarPosicion?.(i);
      });
    });
    this.cadena = resultado.then(
      () => undefined,
      () => undefined,
    );
    return resultado;
  }
}

function ejecutarConLimite<T>(tarea: (control: ControlTarea) => Promise<T>, limiteMs?: number): Promise<T> {
  const controlador = new AbortController();
  return new Promise<T>((resolver, rechazar) => {
    const temporizador = limiteMs
      ? setTimeout(() => {
          const error = new TiempoAgotado(limiteMs);
          controlador.abort(error);
          rechazar(error);
        }, limiteMs)
      : undefined;
    tarea({ signal: controlador.signal, quitarLimite: () => clearTimeout(temporizador) })
      .then(resolver, rechazar)
      .finally(() => clearTimeout(temporizador));
  });
}
