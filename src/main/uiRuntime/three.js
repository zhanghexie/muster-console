/* Offline 3D authoring API. Bundled before the shared bridge and author scripts. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Keep the familiar global alias and maUi.three on the same library instance.
window.THREE = { ...THREE, OrbitControls };
