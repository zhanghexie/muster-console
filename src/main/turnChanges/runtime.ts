import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { app } from 'electron';
import { TurnChangeService } from './service';

export function turnChangesDir(): string {
  return userDataStorage(app.getPath('userData')).resolve('app', 'turn-changes');
}

let service: TurnChangeService | undefined;
export function turnChanges(): TurnChangeService {
  return service ??= new TurnChangeService(turnChangesDir());
}
